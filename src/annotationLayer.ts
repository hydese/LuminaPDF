/**
 * Annotation & Study Tools Engine (Frontend Overlay + Coordinate Transformations + Undo/Redo).
 *
 * Stores all geometry in canonical unrotated PDF page points (1/72 inch) so annotations remain
 * locked to the exact PDF content across zooming, scrolling, layout changes, and dark mode.
 */

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MarkupKind = "highlight" | "underline";

export type AnnotationItem =
  | {
      type: "pen_stroke";
      id: string;
      page_number: number;
      color: string;
      stroke_width: number;
      points: StrokePoint[];
      created_at: string;
    }
  | {
      type: "highlighter_stroke";
      id: string;
      page_number: number;
      color: string;
      stroke_width: number;
      opacity: number;
      points: StrokePoint[];
      created_at: string;
    }
  | {
      type: "text_note";
      id: string;
      page_number: number;
      x: number;
      y: number;
      color: string;
      title: string;
      content: string;
      created_at: string;
      updated_at: string;
    }
  | {
      type: "text_markup";
      id: string;
      page_number: number;
      kind: MarkupKind;
      color: string;
      rects: PdfRect[];
      text_snippet: string;
      created_at: string;
    };

export interface DocumentAnnotations {
  pages: Record<string, AnnotationItem[]>;
}

export type StudyTool =
  | "select"
  | "pen"
  | "highlighter"
  | "highlight_text"
  | "underline_text"
  | "note"
  | "eraser"
  | "snip";

export function screenToPageCoords(
  screenX: number,
  screenY: number,
  pageWidthPt: number,
  pageHeightPt: number,
  zoomScale: number,
  rotationDeg: number
): [number, number] {
  const scale = Math.max(0.05, zoomScale);
  const rx = screenX / scale;
  const ry = screenY / scale;
  const rot = ((rotationDeg % 360) + 360) % 360;

  switch (rot) {
    case 90:
      return [
        Math.max(0, Math.min(pageWidthPt, ry)),
        Math.max(0, Math.min(pageHeightPt, pageHeightPt - rx)),
      ];
    case 180:
      return [
        Math.max(0, Math.min(pageWidthPt, pageWidthPt - rx)),
        Math.max(0, Math.min(pageHeightPt, pageHeightPt - ry)),
      ];
    case 270:
      return [
        Math.max(0, Math.min(pageWidthPt, pageWidthPt - ry)),
        Math.max(0, Math.min(pageHeightPt, rx)),
      ];
    default:
      return [
        Math.max(0, Math.min(pageWidthPt, rx)),
        Math.max(0, Math.min(pageHeightPt, ry)),
      ];
  }
}

export function pageToScreenCoords(
  xPt: number,
  yPt: number,
  pageWidthPt: number,
  pageHeightPt: number,
  zoomScale: number,
  rotationDeg: number
): [number, number] {
  const scale = Math.max(0.05, zoomScale);
  const rot = ((rotationDeg % 360) + 360) % 360;
  let rx = xPt;
  let ry = yPt;
  if (rot === 90) {
    rx = pageHeightPt - yPt;
    ry = xPt;
  } else if (rot === 180) {
    rx = pageWidthPt - xPt;
    ry = pageHeightPt - yPt;
  } else if (rot === 270) {
    rx = yPt;
    ry = pageWidthPt - xPt;
  }
  return [rx * scale, ry * scale];
}

export function pointToSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-6) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitTestAnnotation(
  item: AnnotationItem,
  xPt: number,
  yPt: number,
  radiusPt: number
): boolean {
  if (item.type === "pen_stroke" || item.type === "highlighter_stroke") {
    const threshold = radiusPt + item.stroke_width * 0.5;
    if (item.points.length === 1) {
      return Math.hypot(xPt - item.points[0].x, yPt - item.points[0].y) <= threshold;
    }
    for (let i = 0; i < item.points.length - 1; i++) {
      const a = item.points[i];
      const b = item.points[i + 1];
      if (pointToSegmentDistance(xPt, yPt, a.x, a.y, b.x, b.y) <= threshold) {
        return true;
      }
    }
    return false;
  }
  if (item.type === "text_note") {
    return (
      xPt >= item.x - 6 - radiusPt &&
      xPt <= item.x + 28 + radiusPt &&
      yPt >= item.y - 6 - radiusPt &&
      yPt <= item.y + 28 + radiusPt
    );
  }
  if (item.type === "text_markup") {
    return item.rects.some(
      (r) =>
        xPt >= r.x - radiusPt &&
        xPt <= r.x + r.width + radiusPt &&
        yPt >= r.y - radiusPt &&
        yPt <= r.y + r.height + radiusPt
    );
  }
  return false;
}

export function cloneAnnotations(annots: DocumentAnnotations): DocumentAnnotations {
  return JSON.parse(JSON.stringify(annots));
}

/**
 * Renders all non-note annotations for `pageNumber` onto the overlay canvas.
 * Ensures highlighters remain readable in both normal and intelligent dark mode.
 */
export function renderPageAnnotationsCanvas(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  items: AnnotationItem[],
  pageWidthPt: number,
  pageHeightPt: number,
  zoomScale: number,
  rotationDeg: number,
  isDarkMode: boolean
): void {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  if (!items || items.length === 0) return;

  for (const item of items) {
    if (item.type === "pen_stroke") {
      if (item.points.length === 0) continue;
      ctx.save();
      ctx.strokeStyle = item.color;
      ctx.fillStyle = item.color;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (item.points.length === 1) {
        const [sx, sy] = pageToScreenCoords(
          item.points[0].x,
          item.points[0].y,
          pageWidthPt,
          pageHeightPt,
          zoomScale,
          rotationDeg
        );
        const r = Math.max(1, (item.stroke_width * zoomScale) / 2);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        for (let i = 0; i < item.points.length - 1; i++) {
          const p0 = item.points[i];
          const p1 = item.points[i + 1];
          const [x0, y0] = pageToScreenCoords(
            p0.x,
            p0.y,
            pageWidthPt,
            pageHeightPt,
            zoomScale,
            rotationDeg
          );
          const [x1, y1] = pageToScreenCoords(
            p1.x,
            p1.y,
            pageWidthPt,
            pageHeightPt,
            zoomScale,
            rotationDeg
          );
          const pressureFactor = 0.55 + ((p0.pressure + p1.pressure) * 0.5) * 0.9;
          ctx.lineWidth = Math.max(0.8, item.stroke_width * zoomScale * pressureFactor);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }
      ctx.restore();
    } else if (item.type === "highlighter_stroke") {
      if (item.points.length === 0) continue;
      ctx.save();
      ctx.strokeStyle = item.color;
      ctx.globalAlpha = isDarkMode ? 0.34 : 0.38;
      ctx.globalCompositeOperation = isDarkMode ? "screen" : "multiply";
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(4, item.stroke_width * zoomScale);

      ctx.beginPath();
      const [firstX, firstY] = pageToScreenCoords(
        item.points[0].x,
        item.points[0].y,
        pageWidthPt,
        pageHeightPt,
        zoomScale,
        rotationDeg
      );
      ctx.moveTo(firstX, firstY);
      for (let i = 1; i < item.points.length; i++) {
        const [px, py] = pageToScreenCoords(
          item.points[i].x,
          item.points[i].y,
          pageWidthPt,
          pageHeightPt,
          zoomScale,
          rotationDeg
        );
        ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    } else if (item.type === "text_markup") {
      ctx.save();
      ctx.fillStyle = item.color;
      ctx.strokeStyle = item.color;
      for (const rect of item.rects) {
        const [x0, y0] = pageToScreenCoords(
          rect.x,
          rect.y,
          pageWidthPt,
          pageHeightPt,
          zoomScale,
          rotationDeg
        );
        const [x1, y1] = pageToScreenCoords(
          rect.x + rect.width,
          rect.y + rect.height,
          pageWidthPt,
          pageHeightPt,
          zoomScale,
          rotationDeg
        );
        const rx = Math.min(x0, x1);
        const ry = Math.min(y0, y1);
        const rw = Math.abs(x1 - x0);
        const rh = Math.abs(y1 - y0);

        if (item.kind === "highlight") {
          ctx.globalAlpha = isDarkMode ? 0.32 : 0.38;
          ctx.globalCompositeOperation = isDarkMode ? "screen" : "multiply";
          ctx.fillRect(rx, ry, rw, rh);
        } else {
          ctx.globalAlpha = 0.92;
          ctx.lineWidth = Math.max(1.5, 1.8 * zoomScale);
          ctx.beginPath();
          ctx.moveTo(rx, ry + rh);
          ctx.lineTo(rx + rw, ry + rh);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
}
