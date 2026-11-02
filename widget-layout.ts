import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface AgentCard {
  agent: string;
  elapsed: string;
  model: string;
  thinking: string;
  currentTool?: string;
  currentToolElapsed?: string;
  contextTokens: number;
}

export interface CardStyle {
  border(text: string): string;
  title(text: string): string;
  muted(text: string): string;
  accent(text: string): string;
}

const GAP = 1;
const MIN_CARD_WIDTH = 34;

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function cardLines(card: AgentCard, width: number, style: CardStyle): string[] {
  if (width <= 0) return [];
  if (width < 3) return [truncateToWidth(style.title(card.agent), width, "")];
  const inner = width - 2;
  const content: string[] = [
    fit(`${style.accent("⏳")} ${style.title(card.agent)} ${style.muted(`· ${card.elapsed}`)}`, inner),
    fit(style.muted(`${card.model}/${card.thinking}`), inner),
  ];
  const tool = card.currentTool
    ? `↳ ${card.currentTool}${card.currentToolElapsed ? ` · ${card.currentToolElapsed}` : ""}`
    : "↳ thinking...";
  const toolLines = wrapTextWithAnsi(tool, inner).slice(0, 2);
  content.push(...toolLines.map(line => fit(style.accent(line), inner)));
  content.push(fit(style.muted(`ctx ${card.contextTokens.toLocaleString()}`), inner));
  const horizontal = style.border("─".repeat(inner));
  return [
    `${style.border("┌")}${horizontal}${style.border("┐")}`,
    ...content.map(line => `${style.border("│")}${line}${style.border("│")}`),
    `${style.border("└")}${horizontal}${style.border("┘")}`,
  ];
}

function widthsForRow(width: number, count: number): number[] {
  const available = Math.max(0, width - GAP * (count - 1));
  const base = Math.floor(available / count);
  const remainder = available % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

export function renderAgentGrid(cards: AgentCard[], width: number, style: CardStyle): string[] {
  if (width <= 0 || cards.length === 0) return [];
  const columns = Math.max(1, Math.min(cards.length, Math.floor((width + GAP) / (MIN_CARD_WIDTH + GAP))));
  const output: string[] = [];
  for (let offset = 0; offset < cards.length; offset += columns) {
    const row = cards.slice(offset, offset + columns);
    const widths = widthsForRow(width, row.length);
    const rendered = row.map((card, index) => cardLines(card, widths[index], style));
    const height = Math.max(...rendered.map(lines => lines.length));
    for (let line = 0; line < height; line++) {
      const joined = rendered.map((lines, index) => lines[line] ?? " ".repeat(widths[index])).join(" ".repeat(GAP));
      output.push(truncateToWidth(joined, width, ""));
    }
  }
  return output;
}
