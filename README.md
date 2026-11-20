# Digital Anti-Corruption Monitor

Команда **ITT-Zholudi (K31)** · [Завдання 2. Моніторинг виконання антикорупційної програми](https://hack.bitec.com.ua/zavdannia-2/)

Розрізнені таблиці й листування ускладнюють контроль строків, доказів і змін ризику. Координатор веде заходи, строки й індикатори в одному реєстрі. Виконавець бачить свої призначення, подає фактичний результат і додає докази. Координатор перевіряє їх, повертає результат на доопрацювання або погоджує. Зміни фіксуються в аудиті. Рольові дашборди показують строки, чергу погодження та сигнали ризику з переходом до заходу.

## Демо

[Демо](https://bitec-hackathon-2026.vercel.app/)

## Що можна перевірити

- Увійти як **Координатор А**, переглянути реєстр, відфільтрувати заходи за розділом, відкрити картку, створити чи відредагувати захід.
- Увійти як **Виконавець А** або **Виконавець Б** і побачити різні списки призначених заходів.
- Під **Виконавцем А** відкрити M-501, подати результат із синтетичним TXT і пройти повернення, заміну доказу та погодження разом із **Координатором А**. [Браузерний сценарій](docs/workflow.md#як-повторити-в-браузері)
- Як **Координатор А** або **Керівник А** відкрийте **Звіти**, перемкніть півріччя, перегляньте довідку та завантажте CSV. [Звітність](docs/reporting.md) · [Наскрізна перевірка](docs/verification.md)
- Відкрити **Огляд** або **Сигнали**, вибрати показник і перейти до відповідного заходу та періоду. [Правила й показники](docs/analytics.md)
- На офіційному синтетичному наборі BITEC відкрити паспорт програми, реєстр із 14 ризиками й звіт H1 із 50 заходами. [Як імпортувати набір](#локальне-демо-на-офіційному-наборі-bitec)

![Звіт координатора за ІІ півріччя на синтетичних даних](docs/images/integrated-report-h2.jpg)

[Звіт A4](docs/examples/half-year-2026-H2-a4.pdf) · [CSV](docs/examples/half-year-2026-H2.csv) · [Довідка](docs/examples/half-year-2026-H2-brief.md) · [Поточний стан приймання](docs/PROGRESS.md) · [План етапів](docs/PROJECT_STAGES.md)

## Як запустити

Потрібні Git, Node.js 24 і npm. Клонуйте публічну `main`. Команди `seed` і `start` нижче запускають локальну демоверсію з навчальним набором.

```bash
git clone https://github.com/Hulkovskyi/bitec-hackathon-2026.git && cd bitec-hackathon-2026
npm ci
npm run build
DEMO_MODE=true npm run seed
DEMO_MODE=true npm start
```

У PowerShell виконайте `$env:DEMO_MODE = "true"` перед `npm run seed` та `npm start`. Відкрийте <http://127.0.0.1:3001>. Для автоматичної перевірки запустіть `npm test`.

### Локальне демо на офіційному наборі BITEC

Після `npm ci` та `npm run build` розпакуйте `dani/nabir.json` з архіву організаторів. Імпортуйте його в окремий файл SQLite. [Синтетичний ZIP BITEC](https://hack.bitec.com.ua/wp-content/uploads/2026/11/zavdannia-2-syntetychnyi-nabir-63022726.zip)

**PowerShell**

```powershell
$env:DEMO_MODE = 'true'
$env:DATABASE_PATH = './data/official-bitec.sqlite'
node scripts/import-official-dataset.mjs 'C:\шлях\до\dani\nabir.json' $env:DATABASE_PATH --verify
npm start
```

**Bash або Zsh**

```bash
export DEMO_MODE=true
export DATABASE_PATH=./data/official-bitec.sqlite
node scripts/import-official-dataset.mjs '/шлях/до/dani/nabir.json' "$DATABASE_PATH" --verify
npm start
```

Під час імпорту очікуйте `rows: 50`, `referenceRows: 50` і `differences: []`. Відкрийте <http://127.0.0.1:3001>, оберіть координатора з ідентифікатором `U-002` і перейдіть до **Звіти → 2026 · І півріччя**. Паспорт і корупційні ризики доступні в меню. Для цього запуску достатньо локальної SQLite.

## Як влаштовано

| Стек | Шлях |
| --- | --- |
| React і Vite | [apps/web](apps/web/) |
| Node.js 24, Express і локальна SQLite | [apps/api](apps/api/) |
| Vercel Hobby, Supabase Free і PostgreSQL | [Онлайн-розгортання](docs/deployment.md) |
| GitHub Actions | [.github/workflows/ci.yml](.github/workflows/ci.yml) |

Реєстр, погодження, правила сигналів і звітність працюють локально без ШІ-сервісу. ChatGPT і Codex використовували під час планування, розробки та перевірки. [Схема й опис архітектури](docs/architecture.md) · [Використання ШІ](docs/ai.md)

Сторонні компоненти застосунку включають React, Vite, Express, Busboy і `pg`. Для онлайн-демо використовуємо Vercel і Supabase. [Точні версії залежностей](package-lock.json) · [Розгортання](docs/deployment.md)

## Документація та подання

- [Контракт реєстру](docs/registry-contract.md) і [відтворення сценарію](docs/registry.md)
- [Результати, докази й погодження](docs/workflow.md) і [контракт наскрізного сценарію](docs/workflow-contract.md)
- [Вимоги організаторів](docs/REQUIREMENTS.md) і [записи етапів](docs/stages/)
- [Карта інтеграцій](docs/integrations.md), [аналіз зловживань](docs/security.md) і [методика замірів](docs/measurements.md)
- [Матеріали подання](docs/submission.md) і [сценарій відео](docs/demo-video.md)
- За повідомленням учасника команди, URL репозиторію подано організаторам. Код для оцінювання має бути в `main` до 20.11, 23:59, документація й відео до 23.11, 10:00 за Києвом. [Правила подання](https://hack.bitec.com.ua/podannia/)

Ліцензія [MIT](LICENSE).
