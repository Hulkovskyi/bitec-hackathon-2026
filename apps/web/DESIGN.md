---
name: Digital Anti-Corruption Monitor
description: Робочий інтерфейс для заходів, сигналів і погоджень
colors:
  background: "#f3f3fa"
  surface: "#ffffff"
  surface-muted: "#f8f8fd"
  stroke: "#e0e0ef"
  stroke-control: "#c9c9df"
  text: "#181a33"
  text-muted: "#5c607a"
  accent: "#5946c9"
  accent-deep: "#4634af"
  accent-muted: "#eeebff"
  navigation: "#202035"
  navigation-text: "#f7f6ff"
  navigation-muted: "#b9b9d1"
  navigation-hover: "#303049"
  navigation-focus: "#b6aaff"
  selection: "#d9d1fb"
  focus: "#8270e3"
  scrollbar: "#c1b9e6"
  positive: "#12664c"
  positive-muted: "#e7f7ef"
  danger: "#a13a4e"
  danger-muted: "#fcecf0"
typography:
  heading:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "2rem"
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1rem"
    lineHeight: 1.5
  label:
    fontSize: "0.875rem"
    fontWeight: 600
  caption:
    fontSize: "0.8125rem"
  small:
    fontSize: "0.75rem"
  title-mobile:
    fontSize: "1.5rem"
  title-login:
    fontSize: "1.75rem"
  panel-title:
    fontSize: "1.25rem"
  section-title:
    fontSize: "1.125rem"
  metric:
    fontSize: "1.875rem"
rounded:
  small: "4px"
  control: "8px"
  panel: "12px"
  gate: "16px"
  badge: "999px"
spacing:
  compact: "8px"
  panel: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
  navigation-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.navigation-text}"
    rounded: "{rounded.control}"
  work-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
---

# Digital Anti-Corruption Monitor

## Overview

Темна навігація відділяє розділи від світлого робочого поля. На панелі видно підсумки й дії, у реєстрі — список і відкриту картку, у погодженні — доказ поруч із рішенням. Це спільна візуальна мова п’яти макетів: кабінету підрозділу, огляду програми, дашборду моніторингу, погодження й реєстру.

## Colors

Фіолетовий виділяє вибір, посилання та основну дію. Зелений підтверджує активний або успішний стан, червоний позначає помилку або прострочення. Статус також має текстове позначення.

## Typography

Системна гарнітура дає українські символи й працює локально без завантаження шрифтів. Заголовок сторінки, назва панелі та підпис поля мають окремі рівні. Дати й лічильники використовують табличні цифри там, де значення порівнюються.

## Layout

На широкому екрані навігація займає окрему колонку. До 740 px меню переходить угору. Реєстр і картка стоять поруч, якщо є місце. На вузькому екрані рядки реєстру показують строк і стан під назвою. Панель результату й доказів переходить до однієї колонки залежно від ширини контейнера.

## Elevation & Depth

Робочі панелі відділяються тонким контуром. Фон підкреслює активний рядок або показник.

## Shapes

Панелі мають радіус 12 px, звичайні кнопки й поля — 8 px. Кругла форма позначає аватар, мітки стану мають округлені краї.

## Components

- **Навігація.** Підпис і піктограма ведуть до доступного розділу. Поточний розділ позначено кольором і `aria-current`.
- **Показник.** Вибір показника відкриває відповідні записи API. Прогрес використовує фактичну частку виконання й має стан без даних. Керівник бачить порівняння доступних підрозділів, а після вибору підрозділу — його прогрес.
- **Реєстр.** Фільтри застосовуються до дозволених записів. Відкрита картка підсвічується. Перехід з огляду зберігає точний період.
- **Погодження.** Черга відкриває окремий екран погодження. Панель показує версію доказу, SHA-256 та рішення. PNG, JPEG і TXT можна переглянути в застосунку після перевірки доступу й цілісності. PDF можна завантажити через той самий захищений маршрут.

## Do's and Don'ts

- Відділяти стан погодження від заявленого підсумку і від сигналу.
- Зіставляти кожен показник із його деталізацією.
- Показувати графік динаміки, коли є ряд історичних даних.
