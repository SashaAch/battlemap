# battlemap

Доска для D&D и других НРИ: клетки по канону 5e, рисование от руки со стенами, фишки, туман войны, игра онлайн. Клиент в браузере (`client/`), сервер мастера на Node (`server/`), на Windows он собирается в один `battlemap.exe`. Пока есть только план.

## Как работать

- Код и тесты пишем по скилу [karpathy-rlm-guidelines](.claude/skills/karpathy-rlm-guidelines/SKILL.md).
- Работа идёт по плану в [.branch-kb/main/](.branch-kb/main/index.md): начинать с блока «Состояние на сейчас» в `progress.md`, дальше по скилу [staged-plan-work](.claude/skills/staged-plan-work/SKILL.md). Новую крупную часть сначала планируем по [architecture-plan](.claude/skills/architecture-plan/SKILL.md).
- Папка `.branch-kb/` коммитится: работа идёт то на Mac, то на Windows.
- Правка должна работать на обеих системах: концы строк LF, пути через `path.join`, запуск только командами `node ...`.

## Проверки

- `node --test`, нужен Node 22 или новее.
- Сценарии в браузере из графы «Проверка» своего этапа в `plan.md`.

## Что не коммитить

`maps/` (карты мастера), `battlemap.json` (ключ мастера и код комнаты), собранные `.exe`.
