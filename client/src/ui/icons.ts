// Interface icons (R45): line drawings on a 24×24 grid after the shapes of the variant V mock-ups
// (.branch-kb/main/design/Icon.dc.html). They take the text colour (currentColor), so every theme colours them.

const PATHS = {
  select: "M5 3l13 7.5-5.5 1.5-2.5 5.5z",
  brush: "M18 3l3 3-8.5 8.5-3-3z M9.5 14.5c-2 0-4 1.2-4 3.8 0 1-.8 1.9-2 2.2 3.3 1 7.5-.3 7.5-4",
  fill: "M4.5 12L11 5.5l7 7L11.5 19z M4.5 12h13.5 M20 15.5s1.8 2 1.8 3.2a1.8 1.8 0 0 1-3.6 0c0-1.2 1.8-3.2 1.8-3.2z",
  room: "M4 4h16v16H4z M4 11h5 M13 11h7 M11 4v4 M11 14v6",
  walls: "M3 5h18v14H3z M3 9.7h18 M3 14.3h18 M8 5v4.7 M16 5v4.7 M12 9.7v4.6 M8 14.3V19 M16 14.3V19",
  objects: "M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8",
  tokens:
    "M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 13.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M7.8 18.2c.9-1.7 2.4-2.6 4.2-2.6s3.3.9 4.2 2.6",
  pencil: "M4 20l1-4L16 5l3 3L8 19z M13.5 7.5l3 3",
  ruler: "M3.5 16.5L16.5 3.5l4 4-13 13z M7.5 12.5l2 2 M10.5 9.5l2 2 M13.5 6.5l2 2",
  eraser: "M3.5 15.5l9.5-9.5 6 6-7 7H7.5z M8.5 10.5l6 6 M10 20h10",
  ping: "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M12 2v2 M12 20v2 M2 12h2 M20 12h2",
  undo: "M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeoff:
    "M3 3l18 18 M10.6 5.1C11 5 11.5 5 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 3.9 M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7c1.6 0 3.1-.4 4.4-1.1 M9.9 9.9a3 3 0 0 0 4.2 4.2",
  chevron: "M6 9l6 6 6-6",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  back: "M15 18l-6-6 6-6",
  qr: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h2.5v2.5H14z M17.5 17.5H20V20h-2.5z M14 20h2 M20 14v2",
  close: "M6 6l12 12 M18 6L6 18",
} as const;

export type IconName = keyof typeof PATHS;

const SVG = "http://www.w3.org/2000/svg";
const STROKE_WIDTH = "1.8";

/** An icon `size` CSS pixels square, hidden from screen readers: the button around it carries the name. */
export function icon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", STROKE_WIDTH);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}