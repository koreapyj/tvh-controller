/*
 * tvh-controller - Centralized tvheadend controller
 * Copyright (C) 2026 Yoonji Park
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

// Pure autoscroll-arming logic for scrollable log panes (SessionModal): stick
// to the bottom while the viewer hasn't scrolled away, stop once they scroll
// up to read history. No Svelte/DOM imports — everything here is
// node-testable against a plain {scrollTop, scrollHeight, clientHeight} shape.

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** "close enough to the bottom" slack, in pixels (sub-pixel scroll rounding, etc.) */
export const AUTOSCROLL_THRESHOLD_PX = 40;

/** true when the viewport's bottom edge is within `thresholdPx` of the content bottom */
export function isAtBottom(m: ScrollMetrics, thresholdPx: number = AUTOSCROLL_THRESHOLD_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= thresholdPx;
}

/**
 * Recompute the "autoscroll armed" state from the pane's current scroll
 * metrics — call on every scroll event (not just once): scrolling back down
 * to the bottom re-arms it, scrolling up disarms it. Same rule as
 * isAtBottom; kept as a separate name for call-site clarity.
 */
export function nextArmedState(m: ScrollMetrics, thresholdPx: number = AUTOSCROLL_THRESHOLD_PX): boolean {
  return isAtBottom(m, thresholdPx);
}
