# PROGRESS — сайт ТОО «Энергоконструкция»

Файл для возобновления работы после обрыва сессии. Обновлять после каждого этапа.

## Этапы
- [x] 1. PDF заказчика → research/01-client.md (+ pdf/text.txt, pages/, img/)
- [x] 2. Каталог конкурента → research/02-competitor-catalog.md, competitor/catalog.json (112 опор), competitor/images/
- [x] 3. Исследование ~60 сайтов (+~20 заблокированных) → research/03-references.md. Кадры: scratchpad/refs*/<site>/sheet.jpg
- [x] 4–7. Направления, выбор, UX каталога, motion → research/04-design-direction.md
- [x] 8. Реализация → site/ (Vite + TS + GSAP + Lenis + Three.js). README в site/README.md
- [x] 9. QA: desktop 1440/1280, mobile 390 touch, reduced-motion, Lighthouse perf 92 / a11y ~97 / BP 100 / SEO 100. Превью: `npm run preview` → :4319 (порт 4173 занят сайтом ЭЛТО пользователя — не трогать)

## Решения
- Направление «Сборка»: чертёж → металл. Палитра paper #EEF0EE / zinc / graphite #1C2226 / signal #F5C400.
- Шрифты Geologica + IBM Plex Mono (только выноски), self-host.
- Google Flow: требует личного входа пользователя (status awaiting_user_fresh_sign_in) — видео не генерировали, визуалы процедурные.
- НЕ использовать: p09_0 (под ним контакты ЗМК Энерго), логотипы партнёров.
- «?» в марках проводов конкурента = потерянный «÷», выводим «÷».
- Силуэты опор: scratchpad/silhouette.py (тёмные линии → PNG с альфой, bbox ≈ высота H).

## Изменение (по запросу пользователя): без изображений конкурента
- Higgsfield: 10 кредитов, free-план, генерация «Requires basic plan» → AI-генерация недоступна. Пользователь выбрал «свои векторные чертежи».
- scripts/redraw.py: измерение контура (ствол, траверсы) → процедурная решётка, SVG в public/catalog/. Ручные описания особых форм: scripts/tower_overrides.json.
- Из public/ и dist/ удалены все jpg/webp конкурента и силуэты. В catalog.json нет полей image/sil/bbox; есть svg + draw {w,h,axis,ground,top,u,type}.
- Исходники конкурента остались только в research/competitor/images (для измерения, на сайт не попадают).
