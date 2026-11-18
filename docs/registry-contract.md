# Контракт реєстру MVP v1 — Issue #1

Статус: пропозиція архітектора для незалежного перегляду. Це специфікація майбутньої реалізації, а не опис готових функцій.
База огляду: main, коміт 1d0af5cb25d43710bd3bddf17c4b84caf41677a5. На момент огляду відкриті Issues #1–#5, відкритих PR немає; API реалізує лише GET /api/health.

## Мета та межі

Координатор створює захід у своїй програмі та підрозділі, призначає виконавця й індикатор. Виконавець бачить тільки свої заходи. Керівник і аналітик читають реєстр у наданих межах. Адміністратор керує демообліковими записами та довідниками.

Issue #1 включає міграції, синтетичний seed, демосесії, серверну авторизацію, API реєстру та мінімальний React-інтерфейс: вибір демокористувача, список, картка й форма створення/редагування координатора.
Завантаження доказів, результати виконання й погодження — #2; панелі та Risk Flags — #3; звіт — #4. Реальні дані організаторів, зовнішня авторизація та інтеграції МОУ/НАЗК не входять у цю ітерацію.

## Модель даних

Ідентифікатори — UUID TEXT, створені сервером; стабільні UUID у seed. Дати — YYYY-MM-DD, часові позначки — UTC ISO 8601. SQLite: foreign_keys=ON для кожного з'єднання. Обов'язкові поля NOT NULL, посилання FK з ON DELETE RESTRICT. Фізичного видалення доменних записів у v1 немає.

| Таблиця | Поля й обмеження |
| --- | --- |
| schema_migrations | version INTEGER PK, applied_at |
| programs | id PK, code UNIQUE, title, period_start, period_end; start <= end |
| sections | id PK, program_id FK, code INTEGER CHECK IN (1,2,3), title; UNIQUE(program_id, code) |
| departments | id PK, program_id FK, code, title; UNIQUE(program_id, code) |
| users | id PK, display_name, role CHECK IN (executor,coordinator,leader,analyst,admin), active INTEGER CHECK IN (0,1) |
| user_scopes | user_id FK, program_id FK, department_id FK; PK(user_id,program_id,department_id); підрозділ належить цій програмі |
| risks | id PK, program_id FK, code, title; UNIQUE(program_id, code) |
| measures | id PK, section_id FK, department_id FK, executor_id FK users, risk_id nullable FK, code, title, description, schedule_type CHECK IN (one_time,continuous), planned_date nullable, active INTEGER, version INTEGER >= 1, effective_from, created_at, updated_at; UNIQUE(section_id, department_id, code) |
| indicators | id PK, measure_id UNIQUE FK, title, unit, baseline REAL, target REAL, direction CHECK IN (increase,decrease,maintain) |
| audit_events | id PK, actor_id FK users, action, entity_type, entity_id, before_json nullable, after_json nullable, occurred_at |
| sessions | id_hash PK, user_id FK, auth_kind CHECK IN ('demo'), expires_at; сирий токен у БД не зберігається |
| seed_batches | version PK, manifest_hash, applied_at; маркер атомарно завершеного seed |

Межі доступу задаються явними рядками user_scopes; автоматичного wildcard немає. Програма заходу визначається через section_id. Підрозділ, розділ і ризик мають належати одній програмі. Призначення виконавця вимагає точного рядка user_scopes(executorId, programId, departmentId), а не лише збігу programId. Це правило діє для POST, кінцевого стану PATCH та кожного запису імпорту. Виконавець активний і має роль executor; координатор має scope як до початкового, так і до цільового підрозділу. Для розділу 2 risk_id обов'язковий; для 1 і 3 у MVP — null. Перевіряти це в сервісі в межах транзакції, а де можливо — складеними FK/UNIQUE.

effective_from — початок дії заходу, у періоді програми; у POST сервер ставить max(today Europe/Kyiv, program.period_start), якщо today <= program.period_end, інакше 400. Це серверне незмінне поле, у звичайному POST/PATCH не приймається. Для синтетичного історичного імпорту admin явно передає effectiveFrom у межах програми; seed задає його у fixture. Для one_time planned_date обов'язкова й лежить не раніше effective_from та у періоді програми; для continuous — null, строк звіту визначається періодом звіту. baseline і target — скінченні числа; increase: target >= baseline, decrease: target <= baseline, maintain: target = baseline. Кожен захід має рівно один індикатор у v1, створений атомарно із заходом. Назви 1–200 символів після trim, description до 4000, code до 50, unit до 50; порожні обов'язкові значення заборонені.

## Авторизація і демосесії

Деморежим увімкнений лише через DEMO_MODE=true, з явним написом «Синтетичні дані / деморежим». Сервер за замовчуванням слухає 127.0.0.1. Перемикання деморолей не є production-автентифікацією. Якщо DEMO_MODE не ввімкнено, демоендпоїнти повертають 404, доменні API без сесії — 401. Кожна сесія має auth_kind=demo. На КОЖНОМУ доменному запиті middleware відхиляє її з 401, якщо поточний DEMO_MODE!=true, незалежно від строку дії cookie та наявності запису в БД. При запуску з вимкненим деморежимом сервер також видаляє demo-сесії; ця очистка не замінює перевірку middleware. Перезапуск з тією самою БД не зберігає доступ; прихованого входу адміністратором немає.

POST /api/demo/session приймає тільки userId зі списку активних демокористувачів. Сервер генерує криптографічно випадковий токен, зберігає SHA-256 та ставить HttpOnly, SameSite=Strict cookie; Secure при HTTPS, TTL 8 годин. GET /api/demo/users повертає лише id/displayName/role синтетичних користувачів. DELETE /api/session анулює сесію. Мутації перевіряють Origin на дозволений origin застосунку; довільні CORS origins не дозволені. Тести й імпорт використовують той самий захист.

Роль і scope сервер бере з БД за сесією, ніколи з role/userId/header у доменному запиті. Неактивний користувач втрачає доступ навіть із виданою сесією. Демоендпоїнти працюють лише із синтетичним набором.

| Операція | Executor | Coordinator | Leader / Analyst | Admin |
| --- | --- | --- | --- | --- |
| Список/картка заходів та індикаторів | призначені йому, у scope | у scope | у scope, читання | усі, читання |
| Створення/редагування заходу | ні | у scope, включно з новим scope при зміні | ні | ні |
| Читання програми/розділів/підрозділів/ризиків | у scope | у scope | у scope | усі |
| Список можливих виконавців | ні | активні executor у вибраному scope | ні | усі |
| Демокористувачі, scopes, довідники: зміна | ні | ні | ні | так |
| Читання аудиту | свого доступного заходу | доступного заходу | ні у v1 | усі |
| Імпорт синтетичного реєстру | ні | ні | ні | так |

У #1 довідники, облікові записи та scopes створюються seed/імпортом; окремий CRUD та адмінпанель — #3. Дозволи на ці майбутні операції тут зафіксовано, але ендпоїнти не заявляються готовими.
Фільтрація доступу застосовується в SQL до pagination і count. Для невідомого або недоступного id — однаковий 404; для недозволеного типу операції — 403. Жодних назв/чисел чужих заходів у списках, помилках або аудиті.

## HTTP API для Issue #1

JSON camelCase, /api зберігається для сумісності з наявним health endpoint. Усі нижченаведені доменні маршрути вимагають сесію. GET /api/health залишається публічним і сумісним.

| Метод і маршрут | Запит / результат |
| --- | --- |
| GET /api/me | {id, displayName, role, scopes:[{programId,departmentId}]} |
| GET /api/programs | {items:[{id,code,title,periodStart,periodEnd}]} у межах доступу |
| GET /api/programs/:id/registry-options | {sections,departments,risks,executors}; executors лише coordinator/admin, кожний {id,displayName,departmentIds:[...]}; departmentIds — перетин точних scopes виконавця й доступних caller підрозділів цієї програми, порожній перетин виключає виконавця |
| GET /api/measures | programId обов'язковий; sectionId,departmentId,executorId,active опціональні; page>=1, pageSize 1–100 (default 20); {items,total,page,pageSize}; порядок code,id |
| GET /api/measures/:id | повний Measure |
| POST /api/measures | CreateMeasure -> 201 Measure, Location |
| PATCH /api/measures/:id | {version,...змінені поля CreateMeasure} -> 200 Measure, version+1 |
| GET /api/measures/:id/audit | page/pageSize як вище; {items,total,page,pageSize}, порядок occurredAt,id |
| POST /api/imports/registry | admin; формат нижче; 201 {created:{programs,sections,departments,users,scopes,risks,measures,indicators}} |

CreateMeasure: {sectionId,departmentId,executorId,riskId,code,title,description,scheduleType,plannedDate,indicator:{title,unit,baseline,target,direction}}.
Measure: усі CreateMeasure + {id,programId,active,effectiveFrom,version,createdAt,updatedAt}; indicator також містить id.
PATCH приймає active; indicator, якщо присутній, передається повністю. Решта пропущених полів зберігаються, null дозволений лише riskId/plannedDate. id, programId, actor, timestamps та невідомі поля відхиляються. Зміну sectionId на іншу програму відхиляти; перенесення між програмами не входить у MVP.
Невідомі query parameters і неправильні типи/дати — 400. Заборонений scope у фільтрі не розширює вибірку.

Код заходу унікальний лише всередині (sectionId, departmentId), не в усьому розділі. Два підрозділи можуть мати code=2.1; у реєстрі та звіті показувати також підрозділ. 409 duplicate_code можливий тільки для колізії в доступному цільовому підрозділі; перевірка доступу передує перевірці унікальності. Для імпорту діє та сама область унікальності. Не повертати id чи назву конфліктного запису.

Помилка: {error:{code,message,fields?}}, без SQL/stack trace. 400 validation_error; 401 unauthenticated; 403 forbidden; 404 not_found; 409 version_conflict / duplicate_code; 413 payload_too_large; 500 internal_error.
Оновлення з WHERE id=? AND version=? і аудит — одна транзакція; при конфлікті 409 без часткових змін. Створення заходу/індикатора/аудиту — одна транзакція. Actor походить із сесії. Аудит незмінний через API; зберігає whitelist змінених доменних полів, не токени.

Приклад створення (UUID підставляються із registry-options):

```json
{
  "sectionId": "<section-2-uuid>",
  "departmentId": "<department-a-uuid>",
  "executorId": "<executor-a-uuid>",
  "riskId": "<risk-program-a-uuid>",
  "code": "2.1",
  "title": "Навчальна перевірка процедури",
  "description": "Синтетичний захід для демонстрації",
  "scheduleType": "one_time",
  "plannedDate": "2026-11-20",
  "indicator": {
    "title": "Частка перевірених навчальних записів",
    "unit": "%",
    "baseline": 0,
    "target": 100,
    "direction": "increase"
  }
}
```

## Міграції, seed та імпорт

Міграція 001 створює нові таблиці й індекси; поточний health SELECT 1 не потребує перетворення даних. Версійні SQL-міграції виконуються по черзі у транзакціях, schema_migrations записується після успіху. Повторний запуск не змінює даних. Відкат помилкової міграції повний; автоматично стирати чи пересоздавати існуючу БД заборонено. Перед ручною міграцією робочої БД робити backup.

Seed — окрема явна команда, тільки DEMO_MODE; стабільні UUID, версійний manifest і одна BEGIN IMMEDIATE транзакція на ВЕСЬ набір (включно з seed_batches). Без INSERT ON CONFLICT DO NOTHING. Перед першою вставкою перевірити всі UUID та унікальні коди з manifest. Якщо будь-який уже зайнятий, зокрема program.code при іншому UUID після імпорту, завершити seed_conflict з ненульовим exit code та повним rollback: жодних дочірніх/сусідніх рядків або маркера seed. Існуючі записи не привласнювати й не перезаписувати. Якщо marker цієї версії вже є і manifest_hash збігається, перевірити існування seed UUID та цілісність посилань і завершити без змін; введені користувачем значення зберегти. Відсутній seed UUID/пошкоджений зв'язок -> seed_inconsistent без часткового ремонту; інший manifest_hash -> seed_version_conflict. Нові seed-набори мають нову версію; не виправляти колізію стиранням БД. Мінімум: дві програми, по три розділи, два підрозділи першої і один другої; два виконавці й координатор із різними scopes, окремий користувач другої програми, керівник, аналітик, адміністратор, неактивний executor. По одному заходу кожного розділу першої програми та один у другій; індикатори increase/decrease/maintain, одноразовий і постійний строк. Для перевірки ізоляції потрібні як чужий підрозділ у тій самій програмі, так і інша програма.

Імпорт v1 — JSON {schemaVersion:1, synthetic:true, programs:[], sections:[], departments:[], users:[], scopes:[], risks:[], measures:[]}. Поля записів відповідають таблицям у camelCase; measures включають вкладений indicator. Кожен запис має UUID id; scopes — {userId,programId,departmentId}. Users: {id,displayName,role,active}; паролі/токени не приймаються. effectiveFrom обов'язковий для імпортованого заходу і перевіряється за правилами вище. Відсутні createdAt/updatedAt/version генерує сервер; передані серверні поля відхиляються. Максимум 1 MiB та 1000 записів сумарно (включно з indicators); невідома schemaVersion/поля, повтор UUID або невалідне посилання — відмова всьому пакету. Пакет create-only: наявний UUID/код -> 409, ніякого неявного overwrite чи видачі нових scopes. Посилання можуть вести на наявні або включені в пакет записи; усі перевірки виконуються до commit. Для нового program пакет містить рівно три sections. Аудит імпорту та створення записів — у тій самій транзакції.

Це внутрішній формат синтетичного обміну. Оригінальний файл організаторів не наданий; сумісність з їх форматом НЕ перевірена. Після отримання зразка потрібен окремий адаптер до цього контракту і тест зі знеособленим/синтетичним fixture.

## Межі наступних задач

#2 додає результати й версії доказів окремими таблицями, а не перезаписує плановий індикатор. Запропоновані стани результату: draft -> submitted -> approved або returned; returned -> submitted після виправлення. Executor редагує лише власний draft/returned, coordinator погоджує/повертає у scope, повернення вимагає коментаря. Approved незмінний у MVP. Кожен перехід — атомарно з аудитом і перевіркою version. Детальні payload/таблиці погодити до початку #2.
#3 обчислює overdue/dueSoon окремо від стану погодження. Для кожного сигналу зберігає/повертає правило та значення-джерела; не оголошує людину винною.
#4 використовує той самий scope і вибірку, що реєстр, погоджені результати та обраний звітний період. Continuous відображається датою 30.06 або 31.12; «Строк виконання не настав» — звітне відображення, не статус погодження.

## Критерії приймання та передача

1. На чистій БД міграція й seed працюють; повторний запуск не дублює даних і не стирає зміни. Попередній імпорт program із seed-code та іншим UUID -> seed_conflict, уся БД незмінна, seed_batches порожня; тестувати також збій останньої вставки, щоб довести rollback усього набору.
2. Усі п'ять ролей перевірені через HTTP. Executor бачить власні записи; підміна id, query, body і ролі не відкриває чужі заходи/аудит. Coordinator не може призначити виконавця або підрозділ поза scope; leader/analyst не пишуть, admin не погоджує й не редагує заходи як coordinator.
3. Два підрозділи A/B однієї програми: executor зі scope A не призначається на B через POST/PATCH/імпорт (400 без змін), навіть якщо coordinator бачить A і B; registry-options показує тільки валідні departmentIds. Усі розділи, ризики, виконавці та індикатори узгоджені; невірний ризик/дата/ціль/зв'язок -> 400 без запису й аудиту.
4. Створення і PATCH атомарні; повтор зі старою version -> 409. Тест штучної помилки вставки аудиту доводить rollback заходу та індикатора.
5. Pagination/count не містять чужих даних. Неактивна/прострочена/відсутня сесія -> 401; демовхід при DEMO_MODE=false -> 404. Видати cookie admin при DEMO_MODE=true, перезапустити з тією самою БД та DEMO_MODE=false: старий cookie на GET /api/me і POST /api/imports/registry -> 401. Middleware перевірити також зі штучно збереженим demo session row.
6. Імпорт валідного fixture працює; невалідне посилання, повторний пакет, завеликий body й роль не-admin відхиляються без часткового імпорту. Реальні дані не використовуються.
7. У React координатор створює захід і бачить картку; призначений executor бачить його після входу, інший — ні. Відобразити loading/empty/error і пояснення 409 з оновленням картки.
8. При прихованому code=2.1 у B створення такого коду в доступному A -> 201; повтор у A -> 409. Наявність/відсутність запису в B не змінює відповіді, total та помилки caller A. Коди в імпорті використовують (section,department,code).
9. npm ci, npm test, npm run build успішні; докази HTTP-тестів і браузерного сценарію наведені в PR реалізації.

Результати реалізації та приймання Issue №1 наведено в [записі етапу 1](stages/01-registry.md).

## Узгодження наступних етапів

[Контракт наскрізного сценарію](workflow-contract.md) уточнює #2–#4: окремі результати постійного заходу за півріччями, відмінність outcome від approval, заморожування планових полів після подання з окремим перепризначенням виконавця незакритого періоду, версії доказів, правила сигналів і звіту. baseline/target/actual для правил MVP нормалізуються до 6 десяткових знаків. Нові обмеження frozen plan вводяться разом із міграцією 002; до появи результатів у #1 вони не блокують редагування. Міграція 003 додає version до users для адміністративного PATCH. Починаючи з 002, точні правила читання/редагування результатів та призначень за periodKey визначає WORKFLOW_CONTRACT; базовий executor_id заходу — лише початковий виконавець, не заміна історії призначень.

З міграції 002 чинне призначення обчислюється за ключем періоду й має пріоритет над базовим executor_id у списку, картці та похідних вибірках. Права на історичну revision та окрему версію доказу визначає WORKFLOW_CONTRACT.
