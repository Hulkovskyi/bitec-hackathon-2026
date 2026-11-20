#!/usr/bin/env python3
"""Compare the supplied BITEC tables without extracting the ZIP."""

import argparse
import csv
import io
import json
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib
from pathlib import Path


TABLE_ROWS = {
    "prohrama": 1,
    "rozdily": 3,
    "pidrozdily": 14,
    "roli": 5,
    "korystuvachi": 19,
    "ryzyky": 14,
    "vymiriuvannia_indykatoriv": 39,
    "zakhody": 50,
    "vykonannia_2026_h1": 50,
    "pidtverdzhennia": 41,
    "perenesennia_strokiv": 3,
    "zhurnal_dii": 169,
    "zvit_portal_2026_h1": 50,
}
KEY_HEADER = ["kod", "obiekt", "id", "sygnal", "poiasnennia"]
KEY_CASES = 29
MAX_ARCHIVE_BYTES = 5 * 1024 * 1024
MAX_CONTENT_BYTES = 12 * 1024 * 1024
MAX_MEMBERS = 128
MAX_DIFFERENCES = 15
XML = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PACKAGE_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"


class MaterialsError(Exception):
    pass


def check(condition, message):
    if not condition:
        raise MaterialsError(message)


def checked_archive(archive):
    entries = archive.infolist()
    check(len(entries) <= MAX_MEMBERS, "Забагато файлів в архіві.")
    check(sum(entry.file_size for entry in entries) <= MAX_CONTENT_BYTES, "Вміст архіву завеликий.")
    check(len({entry.filename for entry in entries}) == len(entries), "В архіві є повторні шляхи.")
    check(not any(entry.flag_bits & 1 for entry in entries), "Архів містить зашифровані файли.")


def read_csv(contents):
    return list(csv.reader(io.StringIO(contents.decode("utf-8-sig"), newline=""), strict=True))


def xml_file(archive, name):
    content = archive.read(name).decode("utf-8-sig")
    check(not re.search(r"<!DOCTYPE|<!ENTITY", content, re.IGNORECASE), "Недопустима декларація в XLSX.")
    return ET.fromstring(content)


def xml_text(element):
    return "".join(node.text or "" for node in element.findall(".//x:t", XML))


def worksheet_paths(book):
    relations = xml_file(book, "xl/_rels/workbook.xml.rels")
    targets = {}
    for link in relations.findall(f"{PACKAGE_REL}Relationship"):
        if link.attrib.get("Type", "").endswith("/worksheet"):
            target = link.attrib["Target"]
            check(link.attrib.get("TargetMode", "Internal") == "Internal", "XLSX містить зовнішній аркуш.")
            path = posixpath.normpath(target.lstrip("/") if target.startswith("/") else "xl/" + target)
            check(path.startswith("xl/worksheets/") and path.endswith(".xml"), "Некоректний шлях аркуша XLSX.")
            targets[link.attrib["Id"]] = path
    sheets = xml_file(book, "xl/workbook.xml").findall("x:sheets/x:sheet", XML)
    paths = {sheet.attrib["name"]: targets[sheet.attrib[f"{REL}id"]] for sheet in sheets}
    check(len(paths) == len(sheets), "У XLSX є аркуші з однаковою назвою.")
    check(set(paths).difference({"README"}) == set(TABLE_ROWS), "Назви аркушів XLSX не відповідають набору.")
    return paths


def spreadsheet_value(cell, shared_strings, name):
    check(cell.find("x:f", XML) is None, f"XLSX: формула в таблиці {name}.")
    cell_type = cell.attrib.get("t", "n")
    if cell_type == "inlineStr":
        return xml_text(cell)
    value = cell.findtext("x:v", "", XML)
    if cell_type == "s":
        check(value.isascii() and value.isdecimal() and len(value) <= 7, f"XLSX: некоректний індекс рядка в {name}.")
        number = int(value)
        check(number < len(shared_strings), f"XLSX: відсутній спільний рядок у {name}.")
        return shared_strings[number]
    if cell_type == "b":
        check(value in {"0", "1"}, f"XLSX: некоректне логічне значення в {name}.")
        return "True" if value == "1" else "False"
    check(cell_type in {"n", "str", "d"}, f"XLSX: непідтримуваний тип клітинки в {name}.")
    return value


def spreadsheet_rows(book, path, shared_strings, name, columns):
    rows = xml_file(book, path).findall("x:sheetData/x:row", XML)
    check(len(rows) == TABLE_ROWS[name] + 1, f"XLSX: неправильна кількість рядків у {name}.")
    result = []
    for row_number, row in enumerate(rows, 1):
        check(row.attrib.get("r") == str(row_number), f"XLSX: неправильний номер рядка в {name}.")
        values = [""] * columns
        seen = set()
        for cell in row.findall("x:c", XML):
            match = re.fullmatch(r"([A-Z]{1,3})([1-9]\d{0,5})", cell.attrib.get("r", ""))
            check(match and match[2] == str(row_number), f"XLSX: некоректна адреса клітинки в {name}.")
            column = 0
            for letter in match[1]:
                column = column * 26 + ord(letter) - ord("A") + 1
            check(column <= columns and column not in seen, f"XLSX: зайва або повторна клітинка в {name}.")
            seen.add(column)
            values[column - 1] = spreadsheet_value(cell, shared_strings, name)
        result.append(values)
    return result


def unique_json_object(pairs):
    result = dict(pairs)
    check(len(result) == len(pairs), "JSON містить повторні ключі.")
    return result


def json_scalar(value, name):
    if value is None:
        return ""
    check(type(value) in {str, int, bool}, f"JSON: непідтримуваний тип значення в {name}.")
    return str(value)


def json_table(records, name, headings):
    check(isinstance(records, list) and len(records) == TABLE_ROWS[name], f"JSON: неправильна кількість рядків у {name}.")
    field_set = set(headings)
    check(headings and len(field_set) == len(headings), f"CSV: відсутні або повторні заголовки в {name}.")
    converted = [headings]
    for record in records:
        check(isinstance(record, dict) and set(record) == field_set, f"JSON: різні поля в рядках {name}.")
        converted.append([json_scalar(record[field], name) for field in headings])
    return converted


def verify_key(archive, prefix, tables):
    rows = read_csv(archive.read(prefix + "kliuch/ochikuvani-sygnaly.csv"))
    check(len(rows) == KEY_CASES + 1 and rows[0] == KEY_HEADER, "Ключ сигналів має неправильний формат або кількість кейсів.")
    subjects = {"zakhid": "zakhody", "pidrozdil": "pidrozdily", "ryzyk": "ryzyky"}
    visible_ids = {kind: {record["id"] for record in tables[table]} for kind, table in subjects.items()}
    seen = set()
    for position, row in enumerate(rows[1:], 2):
        check(len(row) == len(KEY_HEADER), f"Ключ сигналів: неправильний рядок {position}.")
        code, subject, identifier, signal, reason = row
        key = code, subject, identifier
        check(re.fullmatch(r"RF(?:[1-6]|7[a-e])", code) and identifier in visible_ids.get(subject, set())
              and signal.strip() and reason.strip() and key not in seen,
              f"Ключ сигналів: невідомий або повторний кейс у рядку {position}.")
        seen.add(key)


def verify_materials(file):
    check(file.is_file(), "Вкажіть файл ZIP.")
    check(file.stat().st_size <= MAX_ARCHIVE_BYTES, "ZIP завеликий.")
    tables_count = {}
    differences = []
    different_cells = 0
    cells = 0
    relative_json = "dani/nabir.json"
    with zipfile.ZipFile(file) as archive:
        checked_archive(archive)
        candidates = [name for name in archive.namelist() if name == relative_json or name.endswith("/" + relative_json)]
        check(len(candidates) == 1, "У ZIP має бути один файл dani/nabir.json.")
        prefix = candidates[0][:-len(relative_json)]
        index = set(archive.namelist())
        resources = ["README.md", "dictionary.md", "generate.py", "kliuch/ochikuvani-sygnaly.csv", "dani/nabir.xlsx"]
        resources.extend(f"dani/{name}.csv" for name in TABLE_ROWS)
        for resource in resources:
            check(prefix + resource in index and archive.getinfo(prefix + resource).file_size > 0,
                  f"У ZIP бракує файла {resource}.")
        payload = json.loads(archive.read(candidates[0]).decode("utf-8-sig"), object_pairs_hook=unique_json_object)
        meta = payload.get("meta") if isinstance(payload, dict) else None
        check(isinstance(meta, dict) and meta.get("syntetychni") is True and meta.get("period") == "2026-H1"
              and meta.get("data_zrizu") == "2026-07-06", "Метадані синтетичного зрізу 2026-H1 не збігаються.")
        tables = payload.get("tablytsi")
        check(isinstance(tables, dict) and set(tables) == set(TABLE_ROWS), "JSON має містити 13 таблиць організаторів.")
        with zipfile.ZipFile(io.BytesIO(archive.read(prefix + "dani/nabir.xlsx"))) as book:
            checked_archive(book)
            paths = worksheet_paths(book)
            shared_strings = []
            if "xl/sharedStrings.xml" in book.namelist():
                shared_strings = [xml_text(item) for item in xml_file(book, "xl/sharedStrings.xml").findall("x:si", XML)]
            for name, records in tables.items():
                csv_rows = read_csv(archive.read(prefix + f"dani/{name}.csv"))
                check(csv_rows, f"CSV: відсутні заголовки в {name}.")
                expected = json_table(records, name, csv_rows[0])
                columns = len(expected[0])
                xlsx_rows = spreadsheet_rows(book, paths[name], shared_strings, name, columns)
                tables_count[name] = len(records)
                cells += len(records) * columns
                for label, rows in (("CSV", csv_rows), ("XLSX", xlsx_rows)):
                    check(len(rows) == len(expected), f"{label}: неправильна кількість рядків у {name}.")
                    for row_number, (received, wanted) in enumerate(zip(rows, expected), 1):
                        check(len(received) == columns, f"{label}: неправильна кількість колонок у {name}, рядок {row_number}.")
                        for column, (left, right) in enumerate(zip(received, wanted), 1):
                            if left != right:
                                different_cells += 1
                                if len(differences) < MAX_DIFFERENCES:
                                    differences.append({"format": label, "table": name, "row": row_number, "column": column})
        verify_key(archive, prefix, tables)
    return {
        "verified": different_cells == 0,
        "period": "2026-H1",
        "sourceAsOf": "2026-07-06",
        "tables": len(tables_count),
        "rows": sum(tables_count.values()),
        "cells": cells,
        "tableRows": tables_count,
        "signalKeyCases": KEY_CASES,
        "differentCells": different_cells,
        "differences": differences,
    }


def main():
    parser = argparse.ArgumentParser(description="Звірити JSON, CSV та XLSX у синтетичному ZIP BITEC.")
    parser.add_argument("archive", type=Path, help="офіційний ZIP для завдання №2")
    args = parser.parse_args()
    try:
        result = verify_materials(args.archive)
    except MaterialsError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, EOFError, KeyError, ValueError, RuntimeError, NotImplementedError, IndexError,
            csv.Error, ET.ParseError, zipfile.BadZipFile, zlib.error):
        print("Не вдалося прочитати ZIP або його таблиці. Перевірте структуру матеріалів.", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["verified"] else 1


if __name__ == "__main__":
    sys.exit(main())
