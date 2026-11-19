# Контракт наскрізного сценарію MVP

Результати, докази й погодження реалізовано на етапі 2. Правила строків і рольові панелі описані в [контракті аналітики](analytics.md). Розділ звітності фіксує вимоги наступного етапу. [Поточний стан](PROGRESS.md)
Базові UUID, помилки, сесії, scopes, optimistic locking і аудит визначені в [контракті реєстру](registry-contract.md). Усі API нижче успадковують їх. Не приймати роль, actor чи scope з тіла запиту. Усі списки, count, докази, агрегати й експорт обмежені серверним доступом.

## Issue #2 — результат, докази, погодження

### Модель та періодичність

Міграція 002 додає:
- results: id, measure_id FK, period_key, revision INTEGER >=1, supersedes_id nullable FK results, executor_id FK users, plan_snapshot_json, status (draft/submitted/returned/approved), outcome (completed/partial/not_completed), description, non_completion_reason nullable, result_date nullable, actual_date nullable, measured_value nullable, version, submitted_at nullable, approved_at nullable, created_at, updated_at. UNIQUE(measure_id,period_key,revision); частковий UNIQUE(measure_id,period_key) WHERE status IN ('draft','submitted','returned') — не більше одного незавершеного результату на період.
- period_assignments: measure_id FK, period_key, executor_id FK users, version; PK(measure_id,period_key). Чинного виконавця визначають окремо для кожного (measure_id, period_key): executor_id явного рядка, якщо він існує, або початковий measures.executor_id, якщо рядка для цього ключа немає.
- evidence_versions: id, result_id FK, logical_file_id, revision INTEGER, original_name, storage_key UNIQUE, media_type, byte_size, sha256, uploaded_by FK, created_at. UNIQUE(logical_file_id,revision); logical_file_id ніколи не переходить між results.
- result_reviews: id, result_id FK, decision (return/approve), comment, actor_id FK, created_at, result_version. Записи незмінні.

Одноразовий захід має period_key=once. Постійний — YYYY-H1 або YYYY-H2. Півріччя належить заходу лише якщо перетин [half.start,half.end] з [max(program.period_start,measure.effective_from),program.period_end] непорожній. Цей перетин називається робочим інтервалом; результати й призначення неіснуючого періоду -> 400. Для кожного півріччя окремий результат; погодження H1 не закриває H2.

result_date — дата стану виконання, обов'язкова перед submit; для completed/partial вона дорівнює actual_date, для not_completed це дата, на яку зафіксовано невиконання. result_date не пізніше серверного today Europe/Kyiv. Для once result_date та ненульова actual_date належать [max(program.period_start,effective_from),program.period_end]. Для continuous обидві дати належать РОБОЧОМУ ІНТЕРВАЛУ, а не всьому півріччю; null actual_date допустима лише для not_completed. Пізній ввід у липні результату H1 дозволено, якщо result_date у робочому інтервалі H1; created_at/submitted_at зберігають реальний час вводу.

При створенні draft дозволені порожні description та null у датах/вимірюванні; перед submit опис обов'язковий (1–4000 символів). completed/partial потребує actual_date, скінченного measured_value та хоча б одного актуального підтвердження від results.executor_id; partial/not_completed потребує non_completion_reason (1–4000). not_completed може мати null actual_date й measured_value та подається без файлу: це явно видно координатору. Погодження звіту про невиконання не оголошує захід виконаним.

### Стани, продовження та права

Executor створює/редагує draft або returned для періоду, на який призначений, додає версії доказів, подає на перевірку. Coordinator у точному scope повертає submitted з обов'язковим коментарем або погоджує submitted. Заборонені прямий draft->approved, редагування submitted/approved та самопогодження actor=results.executor_id. Admin не погоджує.
draft -> submitted -> approved або returned -> submitted. Approval повторно перевіряє вимоги submit та цілісність актуальних файлів цього виконавця. Plan snapshot (programId, sectionId/code/title, departmentId/code/title, measure code/title/description/scheduleType/plannedDate/effectiveFrom та indicator title/unit/baseline/target/direction) фіксується на submit; при поверненні не переписувати минулий review/audit.

Approved запис, його executor_id, plan_snapshot_json, дати, доказові версії та review незмінні. Продовження — НОВИЙ result із наступною revision та supersedes_id, не PATCH старого. POST створює revision=1, якщо результатів немає; інакше дозволений тільки коли останній результат approved partial/not_completed і немає відкритої revision. Якщо останній approved completed — 409 already_completed. Нова revision має власні докази; сервер не переносить файли потай. result_date нової revision >= result_date попередньої, actual_date — не раніше попередньої ненульової actual_date. Не приймати revision/supersedesId з клієнта: обчислити в транзакції, конкурентний POST -> 409. Такий самий механізм доступний для неповного результату continuous у його робочому інтервалі.

Планові поля заходу й індикатора заморожені, якщо є submitted/approved. Зміна плану потребує окремого механізму поза MVP. ВИНЯТОК: coordinator може окремим API перепризначити executor для конкретного НЕЗАКРИТОГО periodKey. Це не PATCH плану й не зміна approved історії. H1 approved не блокує перепризначення H2; once approved partial/not_completed не блокує нового виконавця для наступної revision. period із latest approved completed або submitted результатом -> 409; submitted спочатку повернути. Новий виконавець активний, role=executor, має точний (userId,programId,departmentId); coordinator бачить цей підрозділ. Якщо є draft/returned, його executor_id змінюється й version зростає з аудитом. Докази зберігаються з початковими result_id, logical_file_id та uploaded_by. Погоджені revisions залишаються незмінними. Операція дозволена, навіть коли попередній executor неактивний. Відсутнє призначення створюється з version=1, наявне — compare-and-swap version+1.

Leader/analyst/coordinator читають результати та докази у scope, admin — усі. Активний executor читає конкретний result, якщо results.executor_id дорівнює actor.id і є точний scope. Для незавершеного result також потрібне чинне призначення на його periodKey. Погоджену revision перевіряти за її незмінним executor_id незалежно від поточного доступу до картки заходу. GET /api/measures/:id/results фільтрує кожну revision за цим правилом і повертає лише доступну історію, без поточного плану. Неактивний executor втрачає доступ і до історії. Деактивація чи вилучення scope залишають історичний executor_id незмінним.

Кожна версія доказу має незмінний uploaded_by із сесії. Для executor читання версії вимагає одночасно права на її result і збігу uploaded_by з actor.id. Застосувати обидві перевірки до файлу та його метаданих у картці результату, історії, аудиті, лічильниках і прямих завантаженнях. Для невідомого або недоступного ID завантаження повертає 404. Доступ до returned після перепризначення дає E2 права на сам результат. Файли E1 залишаються в історії для ролей із дозволеним читанням. Для подання, погодження та перевірки наявності доказів актуальні файли — останні версії логічних файлів, завантажені поточним results.executor_id. E2 додає власні логічні файли. Для заміни потрібні той самий result_id і належність logical_file_id цьому виконавцю. Чужий або невідомий logicalFileId повертає 404 без запису нової версії та зміни result.version.

### API

| Метод | Вхід / результат |
| --- | --- |
| GET /api/measures/:id/results | доступні revisions з id, periodKey, revision, status, outcome, resultDate, version; не повертати чужі результати executor |
| GET /api/measures/:id/assignment?periodKey=... | доступне призначення {executorId,version}; version=0 означає fallback до measures.executor_id |
| PUT /api/measures/:id/assignment | coordinator; {periodKey,executorId,version}; 200 assignment; для fallback version=0, для наявного точна version |
| POST /api/measures/:id/results | {periodKey}; 201 draft наступної revision, version=1; відкритий/завершений completed період -> 409 |
| GET /api/results/:id | Result + дозволені актуальні evidence, evidenceHistory з дозволеними версіями та історія reviews цієї revision з фільтром метаданих доказів |
| PATCH /api/results/:id | {version,outcome?,description?,nonCompletionReason?,resultDate?,actualDate?,measuredValue?}; 200, version+1 |
| POST /api/results/:id/evidence | multipart file, version, logicalFileId?; новий логічний файл або нова revision файла; 201 {evidence,resultVersion} |
| GET /api/evidence/:id/download | потік конкретної версії після перевірки прав на result та uploaded_by для executor, Content-Disposition attachment |
| POST /api/results/:id/submit | {version}; 200 Result |
| POST /api/results/:id/review | {version,decision:"return"|"approve",comment}; 200 Result |
| GET /api/evidence/:id/integrity | coordinator/admin з доступом; {id,expectedSha256,actualSha256,intact}; missing файл -> intact=false, actualSha256=null |
| GET /api/measures/:id/audit?entityType=period_assignment&periodKey=… | Координатор у своєму підрозділі й адміністратор. Повертає items, total, page, pageSize. У записі є actorName, occurredAt і before/after із executorId, executorName та periodKey. |

Кожна мутація Result (включно із завантаженням файла) перевіряє version та збільшує її; конкурентний запит -> 409 без часткового запису. Стани/версія/аудит/review/призначення змінюються в одній SQL-транзакції.
Після міграції 002 GET /api/measures, GET /api/measures/:id і похідні вибірки поточного плану для executor застосовують один фільтр: активний виконавець із точним scope і чинним призначенням на periodKey вибірки. Для одноразового заходу ключ once. Для постійного за замовчуванням ключ півріччя за today Europe/Kyiv, якщо воно належить заходу. Список і картка підтримують явний periodKey (once або YYYY-H1/H2) для роботи з відповідним періодом, зокрема для пізнього подання. Якщо параметр заданий, список включає тільки заходи відповідного типу й періоду. Некоректний формат -> 400, недоступна картка або картка без такого періоду -> 404. У вибірках, де вже відомий період (наприклад, сигнали), використовувати ключ кожного рядка. Фільтрувати до pagination, total, агрегатів і drill-down. Явне призначення замінює базове лише для свого ключа. Якщо воно є, не виконувати fallback навіть після деактивації призначеного користувача. Для історичних погоджених результатів діє окрема перевірка з попереднього розділу.

Список і картка повертають `periodKey` фактичної вибірки та чинний `executorId` за період. Для координатора `baseExecutorId` містить базового виконавця. Це ж базове призначення у POST/PATCH плану передається полем `executorId`. Реєстр дає змогу вибрати півріччя до відкриття картки. Аудит перепризначення доступний координатору у своєму підрозділі й адміністратору ще до створення результату.

### Зберігання файлів

Синтетичні PDF, PNG, JPEG і TXT до 5 МіБ локально та 4 МіБ в онлайн-демо, максимум 10 логічних файлів на виконавця в результаті та 20 версій на логічний файл. Потрібні обмеження потоку до буферизації, перевірка MIME/сигнатури, відхилення HTML/SVG/executable і безпечне відображення назви. storage_key — випадковий серверний UUID; original_name ніколи не використовується як шлях. Каталог поза static web root, download лише через авторизований API, nosniff; не відкривати inline.
Сервер обмежує потік, перевіряє тип і сигнатуру та обчислює SHA‑256. Перевірені байти записуються під новим ключем локально або в приватний bucket Supabase. SQL-транзакція повторно перевіряє права й версію результату та фіксує метадані, версію й аудит. Якщо запис метаданих точно не завершився, сервер прибирає файл. Локальне сховище прибирає старі непосилані файли після проміжку для активних завантажень. Для резервної копії зберігайте метадані й відповідні байти доказів.

## Issue #3 — сигнали й панелі

Розрахунок працює з серверним календарним today у Europe/Kyiv. Тести передають clock залежність, користувач не підміняє системний час через API. active=false виключає майбутні due_soon нагадування, але не прибирає вже прострочені обов'язки чи історичний звіт.
Для once deadline=plannedDate. Для continuous перелічити ВСІ належні заходу півріччя, початок робочого інтервалу яких <= today, включно із завершеними; deadline кожного — кінець його робочого інтервалу. Генерація періодів спирається на program/effective_from, а не на існування result, тому пропущений H1 не зникає 1 липня. На date=deadline прострочення ще немає. Виконаний H1 не створює overdue для H2, невиконаний H1 зберігає власний сигнал (measureId,H1,overdue) навіть після початку/виконання H2. Для кожного періоду брати останню approved revision за revision; draft наступної не скасовує вже погоджений стан.
Погоджений completed результат відповідного periodKey означає виконання; partial/not_completed, навіть approved, не означають повного виконання.

| Rule code | Умова | Пояснення та дія |
| --- | --- | --- |
| overdue | today > deadline і немає approved completed перевірюваного periodKey | показати deadline, today, дні; координатор уточнює причину й план дій |
| due_soon | 0 <= deadline-today <= 7 днів і немає approved completed | показати дату й залишок; нагадати виконавцю |
| missing_evidence | submitted/approved і немає актуального файлу або файл відсутній/пошкоджений | вказати результат/версію; додати доказ до повторного подання або розглянути порушення цілісності |
| target_not_met | approved completed/partial, measured_value не null і ціль не досягнута | increase: actual<target; decrease: actual>target; maintain: actual!=target |
| closed_without_improvement | approved completed, direction increase/decrease і actual не покращив baseline | increase: actual<=baseline; decrease: actual>=baseline; maintain виключено |

target_not_met/closed_without_improvement обчислюються для останньої approved revision періоду; missing_evidence — для останньої submitted revision, якщо така є, інакше для останньої approved. Попередні revisions залишаються в історії, але не створюють дублікати поточних сигналів. Для executor сигнали й count також фільтруються чинним призначенням за periodKey і правом на result, якщо сигнал посилається на нього. sourceValues містить лише доступні дані результату та доказів.

Для чисел використовувати узгоджену точність індикатора (у MVP округлення до 6 десяткових знаків перед порівнянням); зберігати та відображати значення з тією ж точністю. Відсутнє вимірювання показувати як «Немає даних», не нуль. Кількість прапорців не дорівнює кількості заходів: обидві величини окремі. Це сигнали перевірки, не автоматичний висновок про корупцію.
Повторні прострочення і аналіз нечіткого опису — наступна ітерація з окремими правилами/тестами; не приховувати їх як нібито реалізовані.

GET /api/dashboard?programId=... -> {asOf,counts:{measures,completed,overdue,overdueMeasures,dueSoon,pendingReview},items:[...]}; scope як у реєстрі. counts.measures/completed та частка виконання рахують поточні активні зобов'язання (measureId,periodKey), once включається, якщо effective_from<=today. Частка = completed / measures, порожній знаменник -> null з «Немає заходів». counts.overdue — кількість прострочених пар (measureId,periodKey) за ВСІ доступні періоди; окреме overdueMeasures — кількість унікальних заходів серед них. У dueSoon та pendingReview також рахувати пари, не revisions. Заголовки панелі пояснюють ці одиниці; один захід може мати два прострочені періоди. Кожний агрегат має фільтр drill-down, який повертає ті самі id.
GET /api/risk-flags?programId=... -> {asOf,items:[{measureId,resultId?,periodKey,ruleCode,sourceValues,explanation,suggestedAction}]} з pagination за загальним контрактом.
### Заплановане керування рішеннями та демоакаунтами

Запланована міграція 003 додає flag_decisions(id,measure_id,result_id nullable,period_key,rule_code,source_snapshot_json,decision_text,assignee_id,due_date,actor_id,created_at). POST /api/risk-flags/decisions приймає {measureId,resultId?,periodKey,ruleCode,decisionText,assigneeId,dueDate}; coordinator у scope, сервер повторно обчислює сигнал і зберігає source snapshot + аудит. Рішення не вимикає правило; якщо сигнал уже не чинний — 409. Довільний ruleCode відхиляється.

Адмінпанель: GET/POST/PATCH /api/admin/users та /api/admin/scopes, admin-only; users мають version для PATCH, токени не повертаються. Зміну ролі/active/scopes аудитувати атомарно, усі сесії користувача анулювати. Не дозволяти вимкнути/понизити останнього активного admin. Довідники редагувати тільки без порушення FK та frozen плану; конкретні CRUD payload узгодити додатком до контракту перед їх реалізацією. Це не блокує read-only дашборди.
Нагадування MVP — у застосунку; email/SMS/push не підключені.

## Запланований звіт і аналітична довідка

GET /api/reports/half-year?programId=...&year=2026&half=1&format=json|csv.
Доступ: coordinator/leader/analyst у scope; admin — усі; executor не має експорту програми (403). HTML для друку будується з того самого JSON snapshot. Обраний період має перетинатися з програмою.
JSON: {program,period:{start,end},generatedAt,dataAsOf,scope,sections:[{code,title,rows:[]}],summary}. Рядок: {measureId,departmentId,departmentTitle,code,title,effectiveFrom,plannedDate,actualDate,executionState,resultDescription,resultId,resultRevision,resultDate,carriedForward,reviewStatus,indicator:{unit,baseline,target,actual,targetReached}}.
Вибірка визначається effective_from — датою початку дії, не довільним created_at: звичайне створення 15.07 має effective_from=15.07 і не потрапляє в H1. Синтетичний історичний імпорт явно задає effectiveFrom. Не можна змінювати effectiveFrom заднім числом через PATCH.
cutoff = min(today Europe/Kyiv, period.end). Дозволений звіт за півріччя з перетином програми; майбутні рядки показують тільки план, без приписаних виконань.

Для once:
1. Вибрати останню approved revision із result_date <= cutoff (найбільша result_date, потім revision); пізнє approved_at не виключає запис, бо це звіт за поточним dataAsOf.
2. Включити захід, якщо effective_from <= period.end ТА (planned_date <= period.end АБО є approved revision із result_date <= cutoff).
3. Виключити його, якщо є approved completed із actual_date < period.start. Отже дострокове завершення 20.06 при planned_date=20.07 входить у H1 за actual/result_date і не дублюється у H2.
4. partial/not_completed до початку періоду не виключає захід: він переноситься до завершення. Пізніша completed revision із result_date у H2 не переписує H1; там залишається останній стан із result_date <=30.06.
5. Якщо незавершений захід перенесений із минулого півріччя і нової revision немає, показати останній погоджений стан, resultDate та позначку carriedForward=true; відсутність нового результату не видавати за нове виконання.

Для continuous: включати лише коли робочий інтервал обраного півріччя непорожній; обирати останню approved revision ТОЧНОГО periodKey із result_date <= cutoff. Створений 15.07 захід не має інтервалу H1, навіть якщо сама програма річна. Для відсутнього результату рядок залишається зі станом за deadline цього періоду.

Погодження після завершення півріччя дозволено як пізнє внесення. generatedAt/dataAsOf показують, що це поточна версія звіту; історичний «стан як було тоді» без snapshots не обіцяти. Історичні значення погодженого результату беруться з plan_snapshot_json його revision. Обчислення звіту не змінює approved записи.

Правила executionState застосовуються до вибраної approved revision, не до найновішого draft:
1. Approved completed -> «Виконано», partial -> «Виконано частково», not_completed -> «Не виконано».
2. Немає approved і строк після cutoff -> «Строк виконання не настав».
3. Немає approved і строк настав -> «Не виконано / результат не погоджено». reviewStatus окремо показує стан останньої revision обраного періоду; approved resultId/resultRevision посилаються на вибраний погоджений стан. Draft/returned майбутньої revision не затирає його.
Опис approved: description та nonCompletionReason для partial/not_completed. Якщо approved немає — «Погоджений результат відсутній»; не вигадувати причину. Для continuous фактична дата у звіті — period.end (30.06/31.12) лише якщо є approved результат; без нього порожньо. Для once — actual_date або порожньо.
Три заголовки sections брати дослівно з ROADMAP; всі три показувати навіть із нулем рядків. Сортувати section.code, department.code, measure.code, id; однакові коди в різних підрозділах не зливати в один рядок.

В одному запиті зняти read snapshot SQLite. CSV RFC 4180, UTF-8 BOM, подвійні лапки екранувати; клітинки, які починаються з =,+,-,@, tab/CR, нейтралізувати як текст для захисту від формул. Назва файла серверна. JSON/CSV/друк/довідка мають однакові id й суми при однаковому snapshot.
Довідка — детермінований текст із summary: кількість рядків і станів, частка виконання з явним знаменником, проблемні заходи з посиланнями; не використовувати LLM для вигадування причин. Нульовий знаменник -> «Немає даних». Аналітика не показує прихованих scopes.

## Контрольний синтетичний набір

Fixture відносно test clock 2026-11-17, програма 2026:
- A: once 2026-11-10, approved completed 2026-11-09, baseline 0/target 100/actual 100 -> виконано, без overdue.
- B: once 2026-11-10, approved partial, actual 50 -> overdue + target_not_met; звіт «Виконано частково».
- C: once 2026-11-20, draft -> due_soon; звіт «Строк виконання не настав».
- D: once 2026-11-17, absent -> due_soon, не overdue.
- E: continuous, approved completed у H1; H2 absent -> H1 дата 30.06, H2 не виконаний автоматично.
- F: approved completed increase baseline 10/target 20/actual 10 -> target_not_met + closed_without_improvement.
- G: not_completed з причиною без доказу, submitted -> missing_evidence; можливе повернення або погодження невиконання.
- X: чужа програма/підрозділ -> не впливає на доступні count, прапорці, CSV чи довідку.

Тести #2: повний цикл return/resubmit/approve; forbidden переходи; 409; rollback аудиту; підміна evidence id; повторні версії; завеликий/небезпечний файл; checksum mismatch; missing файл; збереження старої версії.
Тести #3: fixture A–G/X, today до/на/після deadline, нульовий denominator, maintain, drill-down, scope, рішення зниклого сигналу.
Тести #4: H1/H2, continuous, пізнє погодження, відсутній approved, три групи, CSV формули/лапки/переноси, однакові totals та scope.


## Регресійні сценарії за рев’ю PR #6

Це критерії майбутньої реалізації, не твердження про вже виконані тести.

| ID | Вхід і дія | Очікуваний результат |
| --- | --- | --- |
| W1 — межі дат | program 15.06–31.12, continuous effectiveFrom=15.06, periodKey=2026-H1; resultDate/actualDate=01.02 | submit -> 400 без зміни status/audit; 15.06 та 30.06 дозволені, 14.06/01.07 відхилені |
| W2 — перепризначення | H1 approved completed для E1; E1 деактивований; coordinator призначає активного E2 з точним scope на H2 | assignment H2 створюється; E2 створює/подає H2; H1/executor_id/файли/аудит незмінні; E2 не читає приватні файли E1 |
| W3 — продовження once | revision1 approved partial або not_completed із resultDate=20.06; нова revision2 completed із resultDate=actualDate=20.07 | POST -> 201, revision2.supersedesId=revision1.id; після approve обидва записи збережені; H1 показує revision1, H2 — revision2; паралельний POST -> 409 |
| W4 — зміна півріччя | continuous effectiveFrom=01.01, немає H1 result; clock 30.06, потім 01.07 | 30.06: due_soon H1, не overdue; 01.07: overdue H1, H2 не overdue; новий період не ховає старий |
| W5 — початок дії | річна програма, continuous створено 15.07 | effectiveFrom=15.07; H1 не містить заходу, H2 містить; не створюється фіктивний overdue H1 |
| W6 — дострокове виконання | once effectiveFrom=01.06, plannedDate=20.07, approved completed resultDate=actualDate=20.06 | H1 містить completed рядок, H2 виключає його як завершений раніше; ні пропуску, ні дублювання |
| W7 — незмінна історія | спроба PATCH approved revision, підміна periodKey, перепризначення submitted/approved completed періоду | відмова без змін; для submitted спочатку return; наступна revision не змінює старі докази |
| W8 — перенесене прострочення | H1 та H2 без completed, clock 01.01 наступного року | два overdue з різними periodKey, overdue=2, overdueMeasures=1; завершення H2 не прибирає overdue H1 |
| W9 — докази поверненого результату | E1 завантажує V1 до R, подає R. Coordinator повертає R і перепризначає E2 в тому самому підрозділі | E2 читає R без V1 у GET, історії чи лічильниках. Прямий download V1 і спроба додати версію до логічного файла E1 -> 404. Для completed/partial повторне подання без власного доказу -> 400. Після додавання доказу E2 подає R, coordinator читає V1 у дозволеній історії |
| W10 — чинне призначення once | E1 та E2 активні й мають точний scope одного підрозділу. Початковий виконавець once — E1. Coordinator додає явне once-призначення E2 | До PUT список, total і картка доступні E1. Після PUT захід зникає зі списку, total і поточних похідних вибірок E1, картка -> 404. E2 бачить захід у тих самих вибірках. Якщо в E1 є своя погоджена partial revision, пряме читання цієї revision і її дозволених доказів залишається доступним |

Fixture A–G/X має effectiveFrom=01.01.2026, resultDate=actualDate для completed/partial; G має resultDate=17.11.2026. Додаткові W1–W10 включити до HTTP/сервісних тестів відповідних Issues #2–#4.
