# AnimeVault — Google Drive для постеров (v1.4.1)

## Архитектура
- Supabase Auth — вход в AnimeVault через email + пароль или GitHub OAuth. Google OAuth используется отдельно для Google Drive.
- Supabase Database хранит записи библиотеки и ID файлов Google Drive.
- Google Drive хранит новые постеры в папке **AnimeVault Posters**.
- IndexedDB хранит локальные Blob-копии для офлайн-режима.
- Старые Supabase Storage-файлы не удаляются автоматически до проверки миграции.

## Google Cloud
1. В проекте `animevault-514915` включить **Google Drive API**.
2. В Google Auth Platform выбрать External и добавить личный аккаунт в Test users, пока приложение находится в Testing.
3. OAuth client должен быть типа **Web application**.
4. В Authorized JavaScript origins добавить `https://maestro-777.github.io`.
5. В PWA используется только Client ID; Client Secret не нужен и не должен публиковаться.
6. Приложение запрашивает delegated scope `https://www.googleapis.com/auth/drive.file`.

## Supabase Edge Function
Из корня проекта выполнить:
```bash
npx supabase login
npx supabase link --project-ref ytmnsnvxjhpejidcndyw
npx supabase functions deploy fetch-poster
```
Функция требует JWT AnimeVault. Она скачивает только HTTPS-изображения с хостов `s1.anilist.co`–`s6.anilist.co`, проверяет MIME type и ограничивает размер 10 МБ. Service-role ключ в PWA не используется.

## Первый запуск
1. Опубликовать изменения из PR на GitHub Pages.
2. Войти в AnimeVault через email + пароль или GitHub OAuth.
3. Открыть «Облако» → «Подключить Google Drive».
4. Разрешить доступ к файлам, созданным AnimeVault.
5. Нажать «Синхронизировать сейчас» или дождаться переноса.

Токен Google хранится только в памяти вкладки и не записывается в Supabase/IndexedDB. После перезагрузки страницы Google Drive нужно подключить повторно.

## Перенос и откат
- Записи с `posterDriveFileId` повторно не загружаются.
- Идентификаторы Drive синхронизируются через `animevault_records`.
- Blob-кэш локален для каждого устройства.
- Старый bucket `animevault-posters` не удалять, пока не проверены все постеры на втором устройстве.
- Новые загрузки в Supabase Storage больше не выполняются.
- Google Drive использует квоту личного аккаунта; это не безлимитное хранилище.
