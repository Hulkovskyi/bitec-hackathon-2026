# Етап 0 — узгодження

**Прийнято в публічну `main`** · 18.11.2026, Europe/Kyiv · Відповідальний за перенесення `StaS228-M`

План етапів додано до публічної `main` у PR №1. На цьому етапі закріплено назву **Digital Anti-Corruption Monitor**, яка відображається в застосунку, і структуру npm workspaces. Публічна ліцензія MIT зберігається. Базовий контракт прийняли в приватному PR №6. [План](../PROJECT_STAGES.md) · [Гілка перенесення](https://github.com/Hulkovskyi/bitec-hackathon-2026/tree/codex/stage-01-registry)

## Карта перенесення

| Джерело в приватній чернетці | Публічний шлях |
| --- | --- |
| `apps/web` і `apps/api` | Ті самі шляхи, включно з міграцією, seed, тестами й синтетичним JSON |
| Маніфести npm, версія Node, атрибути Git і CI | Ті самі шляхи |
| Опис архітектури | [docs/architecture.md](../architecture.md) |
| Контракти, запуск і карта набору | [Реєстр](../registry-contract.md) · [Наскрізний сценарій](../workflow-contract.md) · [Запуск і перевірка](../registry.md) · [Карта набору](../official-dataset-mapping.md) |
| Публічні `frontend/` і `backend/` | Покажчики на робочі каталоги |

Джерело коду — прийнятий коміт `be8f4c8`, приватний merge `b2d8a9f`. Публічна гілка додає документи, скриншот демо й виключення локальної БД з Git. Докази запуску й ізоляції ролей у [записі етапу 1](01-registry.md). Внесок ШІ зафіксовано в [документі](../ai.md), стан — у [прогресі](../PROGRESS.md).

`Hulkovskyi` перевіряє назву, шляхи, документи та збірку в публічному PR. Після приймання команда фіксує інтегрований SHA в записах 0 і 1.## Приймання

`qqlie` перевірив публічний PR замість Hulkovskyi. Назва в README відповідає застосунку, npm workspaces містять `apps/web` і `apps/api`, ліцензія MIT присутня. [PR №3](https://github.com/Hulkovskyi/bitec-hackathon-2026/pull/3) злитий у публічну `main` 18.11.2026. SHA злиття — `7ed5b4d878ef46971edd922b4e63b15a542de419`. [7ed5b4d](https://github.com/Hulkovskyi/bitec-hackathon-2026/commit/7ed5b4d878ef46971edd922b4e63b15a542de419) · [Рев’ю qqlie](https://github.com/Hulkovskyi/bitec-hackathon-2026/pull/3#pullrequestreview-5954024201)
