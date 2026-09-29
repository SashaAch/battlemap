---
type: reference
title: Готовые программы для карт и игры на сетке
description: Что уже есть (Owlbear Rodeo, Dungeon Scrawl, Mipui, Shmeppy, Dungeondraft, Foundry VTT, Roll20 и другие), что у них взять и чем отличается наша доска.
generated: 2026-09-29
status: проверено по сайтам и справкам 2026-09-29; цены, помеченные «не проверено», могли измениться
keywords: [prior art, Owlbear Rodeo, Dungeon Scrawl, Mipui, Shmeppy, Foundry VTT, Roll20, Dungeondraft]
---

# Готовые программы для карт и игры на сетке

## Коротко

- Стены сами по контуру области строят Dungeon Scrawl, Dungeondraft, Mipui, Dungeon Alchemist; у Owlbear Rodeo это делает расширение Dynamic Fog из фигур тумана.
- Протянуть рукой и получить стены по рёбрам сетки умеет Shmeppy (инструмент Edge), только горизонтально и вертикально.
- Обвести комнату рукой с привязкой к сетке в проверенных программах нельзя: у Dungeon Scrawl при включённой привязке точки ставятся только щелчками.
- По устройству к нашей доске ближе всего Foundry VTT: сервер у мастера, игроки заходят из браузера. Стоит $50 разово, стены ставятся по точкам.

Если нужно играть уже сейчас, Foundry VTT или Owlbear Rodeo в паре с Dungeon Scrawl закрывают задачу без своей разработки. Своя доска оправдана быстрым рисованием от руки и сервером мастера без подписки.

## Программы

| Программа | Где и сколько стоит | Что взять |
|---|---|---|
| [Dungeon Scrawl](https://www.dungeonscrawl.com/pricing) | браузер; бесплатно, Pro $5 в месяц; с 2023 года принадлежит Roll20 | область рисуется, стены со штриховкой строятся по контуру; наложенные фигуры сливаются, а стоящие вплотную получают общую стену ([Quick Start](https://help.roll20.net/hc/en-us/articles/39316329067031-Quick-Start-Your-First-Map), [Rectangle](https://help.roll20.net/hc/en-us/articles/16981176489495-Rectangle-Tool)); шаг привязки 1/1, 1/2, 1/3 клетки; режим Rough для пещер |
| [Mipui](https://github.com/amishne/mipui) | браузер; бесплатно, открытый код MIT | Rectangle Room рисует комнату сразу со стенами, стены сливаются; Separators ставят дверь, потайную дверь, окно, решётку ([статья](https://opensource.com/article/22/6/create-maps-dd-game-mipui-free-rpg-day)). Открытый код можно смотреть как образец |
| [Shmeppy](https://shmeppy.com/) | браузер; игрокам бесплатно, ведущему $4.99 в месяц | Edge: щелчок ставит стену на ребро, протягивание рисует цепочку, Shift+щелчок обводит стенами группу клеток одного цвета ([справка](https://forum.shmeppy.com/t/how-to-use-the-edge-tool-on-desktop/1507)); только горизонталь и вертикаль |
| [Owlbear Rodeo](https://blog.owlbear.rodeo/owlbear-rodeo-2-4-release-notes/) | браузер; бесплатный план и платные, цены не проверены | туман рисуется фигурами с привязкой к сетке и краям соседних фигур (версия 2.4, май 2026); расширение [Dynamic Fog](https://extensions.owlbear.rodeo/dynamic-fog) строит стены из фигур тумана, дверь ставится протягиванием по краю |
| [Foundry VTT](https://foundryvtt.com/purchase/) | сервер у себя, игроки из браузера; $50 разово | у стены есть тип: дверь, потайная дверь, окно; привязка к подсетке 1/8 клетки; с Ctrl следующий отрезок продолжает предыдущий ([Walls](https://foundryvtt.com/article/walls/)) |
| [Roll20](https://wiki.roll20.net/Subscription) | браузер; бесплатно, Plus $5.99 и Pro $10.99 в месяц | линейка с выбором правила диагоналей: D&D 5E, чередование 5/10, евклидово, манхэттенское ([Measure Tool](https://help.roll20.net/hc/en-us/articles/360039674913-Measure-Tool)) |
| [Dungeondraft](https://dungeondraft.net/) | компьютер; $19.99 разово | Building создаёт пол и стены сразу, постройки сливаются; двери ставятся только на стену ([обзор](https://encounterlibrary.com/dungeondraft-basics/design-tools/)); выгрузка в Universal VTT |
| [Dungeon Alchemist](https://store.steampowered.com/app/1588530/Dungeon_Alchemist/) | Steam, ранний доступ; цена не проверена | по форме комнаты сам ставит стены, двери, окна, свет и мебель |
| [Excalidraw](https://plus.excalidraw.com/pricing) | браузер; бесплатно, открытый код | сетка по Ctrl/Cmd+', привязка к ней, Ctrl временно отключает привязку; стен и фишек нет |
| [Watabou One Page Dungeon](https://watabou.github.io/dungeon.html) | браузер; бесплатно | генератор подземелий; выгрузка JSON: список прямоугольных комнат и дверей |
| [Inkarnate](https://inkarnate.com/) | браузер; бесплатный и платные планы, цены не проверены | красивые карты мира; для боевых карт на сетке по [обзору](https://www.ttrpgstack.com/tools/inkarnate/) подходит плохо |

## Что берём в план

- Слияние комнат как в Dungeon Scrawl: наложенные сливаются, стоящие вплотную получают общую стену (plan.md, 5.5).
- Типы рёбер как у Mipui и Foundry: стена, дверь, потайная дверь, окно, решётка.
- Стена протягиванием по рёбрам и обводка стенами области одной местности, как Edge у Shmeppy.
- Выбор правила диагоналей в настройках, как линейка Roll20.
- Устройство сервера как у Foundry VTT: сервер у мастера, игроки заходят по ссылке из браузера.
