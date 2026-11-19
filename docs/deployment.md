# Онлайн-розгортання

[Публічне демо BITEC](https://bitec-hackathon-2026.vercel.app) · [Стан API](https://bitec-hackathon-2026.vercel.app/api/health)

Vercel Hobby обслуговує інтерфейс і Express API за однією HTTPS-адресою. Окремий Supabase Free зберігає записи в PostgreSQL і версії доказів у приватному сховищі. Застосунок використовує спільний синтетичний реєстр і вхід через вибір деморолі.

## Повторна публікація

З чистої копії цього репозиторію виконайте `npm ci`, `npm test` і `npm run build` на Node.js 24. Після приймання змін перейдіть на `main`, під’єднайте локальну папку до наявного проєкту `bitec-hackathon-2026` у Vercel і розгорніть його.

```sh
npx vercel link --project bitec-hackathon-2026
npx vercel deploy --prod
```

Поточна публікація Vercel має власну копію збірки. Для наступних релізів джерелом є цей репозиторій. За потреби автоматичної публікації під’єднайте його в **Settings → Git** наявного проєкту Vercel після приймання коду і вкажіть `main` як Production Branch. Змінні зі службовими ключами потрібні лише в Production.

## Відтворення інфраструктури

1. Створіть окремий проєкт Supabase Free для BITEC. Передайте `DEMO_MODE=true`, `DACM_ADMIN_DATABASE_URL` власника бази та `SUPABASE_DB_CA` і виконайте `npm run setup:hosted-demo`. Команда застосує міграції схеми `dacm` і додасть синтетичні записи. Рядок підключення задайте без параметра `sslmode`, бо TLS налаштовано в коді.
2. Увімкніть вхід обмеженої ролі `dacm_runtime` з власним випадковим паролем через захищений адміністративний сеанс. Для роботи API використовуйте Transaction pooler на порту 6543 із користувачем `dacm_runtime.<project-ref>`.
3. Створіть приватний bucket `bitec-evidence`. Встановіть ліміт 4 МіБ і типи `application/pdf`, `image/png`, `image/jpeg`, `text/plain`.
4. У проєкті Vercel Hobby задайте Node.js 24 і корінь репозиторію. Параметри збірки й маршрути містить `vercel.json`. Додайте змінні до Production і розгорніть перевірений коміт.

| Змінна | Значення |
| --- | --- |
| `DACM_DATABASE_URL` | Transaction pooler URL для `dacm_runtime`. Sensitive. |
| `DACM_PUBLIC_ORIGIN` | Публічна HTTPS-адреса демо без кінцевого слеша. |
| `SUPABASE_DB_CA` | PEM-сертифікат із Supabase Database Settings. |
| `SUPABASE_URL` | HTTPS-адреса проєкту BITEC у Supabase. |
| `SUPABASE_SECRET_KEY` | Службовий ключ проєкту BITEC. Sensitive. |
| `SUPABASE_EVIDENCE_BUCKET` | Назва bucket. Типове значення `bitec-evidence`. |

Адміністративний рядок `DACM_ADMIN_DATABASE_URL` потрібен лише для налаштування бази. Зберігайте облікові дані поза Git.

## Перевірка

Після розгортання відкрийте сайт у приватному вікні та перевірте `/api/health`. Увійдіть як координатор і відкрийте **Огляд**. Для перевірки подання і погодження використовуйте [синтетичний сценарій](workflow.md#як-повторити-в-браузері) на свіжій базі. Доступ до файлів перевіряється за демороллю і записом.

Через низьку активність Supabase Free може призупинити базу. Перед показом перевірте її стан та за потреби відновіть проєкт. Локальний запуск описано в [README](../README.md#як-запустити). [Відновлення Supabase](https://supabase.com/docs/guides/platform/pausing)
