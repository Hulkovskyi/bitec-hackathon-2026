# Стан етапів

Стан на 19.11.2026. Етап вважається завершеним після незалежного приймання, успішного CI та злиття в публічну `main`. [Правила](PROJECT_STAGES.md)

| Етап | Стан в основному репозиторії | Доказ / блокер | Наступна дія |
| --- | --- | --- | --- |
| 0. Узгодження | Прийнято | Назва, структура й документи злиті в `main` через [PR №3](https://github.com/Hulkovskyi/bitec-hackathon-2026/pull/3). SHA [7ed5b4d](https://github.com/Hulkovskyi/bitec-hackathon-2026/commit/7ed5b4d878ef46971edd922b4e63b15a542de419) | [Запис етапу](stages/00-foundation.md) |
| 1. Реєстр | Прийнято | [PR №3](https://github.com/Hulkovskyi/bitec-hackathon-2026/pull/3) злитий у `main`, SHA [7ed5b4d](https://github.com/Hulkovskyi/bitec-hackathon-2026/commit/7ed5b4d878ef46971edd922b4e63b15a542de419). Чистий запуск, CI та ізоляцію виконавців підтверджено | [Запис етапу](stages/01-registry.md) |
| 2. Результат і погодження | Прийнято | [PR №5](https://github.com/Hulkovskyi/bitec-hackathon-2026/pull/5) схвалено й злито в `main`, SHA [d93808b](https://github.com/Hulkovskyi/bitec-hackathon-2026/commit/d93808b3d9e8541f18e142a2979c3fe3f6ab64a2). Чистий запуск, 21 тест, CI та цикл погодження підтверджено | [Запис етапу](stages/02-workflow.md) |
| 3. Сигнали й панелі | Прийнято | [PR №7](https://github.com/Hulkovskyi/bitec-hackathon-2026/pull/7) злито в `main`, SHA `f2c4611`. Сигнали й деталізацію повторно перевірено з етапом 4 | [Запис етапу](stages/03-analytics.md) |
| 4. Звітність | Прийнято | [PR №8](https://github.com/Hulkovskyi/bitec-hackathon-2026/pull/8) схвалено й злито в `main` на [35f5c8d](https://github.com/Hulkovskyi/bitec-hackathon-2026/commit/35f5c8d15966e19cdb51c2fa20ba7c8a4e024e74). Звіт, довідка й CSV перевірені після розгортання | [Запис етапу](stages/04-reporting.md) |
| 5. Наскрізне приймання | Прогін підтверджено | F-QA повторено на [35f5c8d](https://github.com/Hulkovskyi/bitec-hackathon-2026/commit/35f5c8d15966e19cdb51c2fa20ba7c8a4e024e74). Онлайн-звіт і CSV перевірено на Vercel | [Запис перевірки](stages/05-acceptance.md) |
| 6. Фіксація й подання | Матеріали готуються | SHA, інструкції й зразки зафіксовано | Записати відео й провести фактичні заміри часу |

## Відкриті рішення

- Використовувати прийняту назву **Digital Anti-Corruption Monitor** у відео й звіті.
- Учасник команди підтвердив у чаті 18.11.2026, що URL цього репозиторію подано через форму. Час подання та лист-підтвердження тут не зафіксовані.
- В офіційному синтетичному наборі 50 заходів, зокрема 5 періодичних. Реєстр підтримує одноразові та постійні заходи й вимагає UUID, baseline/unit/direction індикатора. Для прямого імпорту CSV, JSON і XLSX організаторів потрібні адаптер, тести на чистій базі та звірка з еталонним звітом.
- Hulkovskyi провів незалежне рев’ю [PR №8](https://github.com/Hulkovskyi/bitec-hackathon-2026/pull/8). Факт подання підтверджує капітан.

Після злиття публічного PR команда фіксує інтегрований SHA, результати перевірок і прийнятий стан у відповідному записі етапу.
