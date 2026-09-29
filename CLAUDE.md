# battlemap

Сайт для D&D и других НРИ, который ставят у себя: доска с клетками по канону 5e и стенами от руки, учётные записи, игры с возвратом, друзья, чаты, записки, полный лист персонажа 5e. Весь код на TypeScript: клиент в `client/`, сервер на Node в `server/`. Запуск на Windows одним `battlemap.exe` и на Linux. Пока есть только план.

## Как работать

- Код и тесты пишем по скилу [karpathy-rlm-guidelines](.claude/skills/karpathy-rlm-guidelines/SKILL.md).
- Работа идёт по плану в [.branch-kb/main/](.branch-kb/main/index.md): начинать с блока «Состояние на сейчас» в `progress.md`, дальше по скилу [staged-plan-work](.claude/skills/staged-plan-work/SKILL.md). Новую крупную часть сначала планируем по [architecture-plan](.claude/skills/architecture-plan/SKILL.md).
- Папка `.branch-kb/` коммитится: работа идёт то на Mac, то на Windows.
- Правка должна работать на обеих системах: концы строк LF, пути через `path.join`, запуск только командами `node` и `npm`.

## TypeScript

- Node запускает сервер и тесты из `.ts` без сборки, поэтому только синтаксис, который снимается без преобразования: без `enum`, `namespace` и свойств в параметрах конструктора. Импорты с расширением `.ts`, типы через `import type`.
- Клиент для браузера собирает esbuild в `client/dist/`.
- Во время работы внешние пакеты не нужны; для разработки только `typescript` и `esbuild`.

## Проверки

- `npm run check` (типы) и `node --test`, Node 22.22 или новее.
- Сценарии в браузере из графы «Проверка» своего этапа в `plan.md`.

## Что не коммитить

`data/` (база с учётными записями, настройки, копии), `client/dist/`, собранные `.exe`.
