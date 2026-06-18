import type {
  BrowserAnnotationElement,
  BrowserAnnotationViewport,
} from "./BrowserPanel.annotation";

const PDF_REGION_CROP_PADDING_PX = 4;

interface CropBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function shouldCropBrowserAnnotationImage(element: BrowserAnnotationElement): boolean {
  return element.tag === "pdf-region";
}

export function computeBrowserAnnotationCropBounds(input: {
  element: BrowserAnnotationElement;
  viewport: BrowserAnnotationViewport;
  imageWidth: number;
  imageHeight: number;
  paddingPx?: number;
}): CropBounds | null {
  const { element, viewport, imageWidth, imageHeight } = input;
  const paddingPx = input.paddingPx ?? PDF_REGION_CROP_PADDING_PX;
  const rect = element.rect;

  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return null;
  }

  const leftCss = clamp(rect.x - paddingPx, 0, viewport.width);
  const topCss = clamp(rect.y - paddingPx, 0, viewport.height);
  const rightCss = clamp(rect.x + rect.width + paddingPx, 0, viewport.width);
  const bottomCss = clamp(rect.y + rect.height + paddingPx, 0, viewport.height);

  if (rightCss <= leftCss || bottomCss <= topCss) {
    return null;
  }

  const scaleX = imageWidth / viewport.width;
  const scaleY = imageHeight / viewport.height;
  const left = clamp(Math.floor(leftCss * scaleX), 0, imageWidth - 1);
  const top = clamp(Math.floor(topCss * scaleY), 0, imageHeight - 1);
  const right = clamp(Math.ceil(rightCss * scaleX), left + 1, imageWidth);
  const bottom = clamp(Math.ceil(bottomCss * scaleY), top + 1, imageHeight);

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export async function cropBrowserAnnotationImage(input: {
  dataUrl: string;
  element: BrowserAnnotationElement;
  viewport: BrowserAnnotationViewport;
}): Promise<string | null> {
  if (!shouldCropBrowserAnnotationImage(input.element)) {
    return input.dataUrl;
  }

  const image = await loadImage(input.dataUrl);
  if (!image) {
    return null;
  }

  const bounds = computeBrowserAnnotationCropBounds({
    element: input.element,
    viewport: input.viewport,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
  });
  if (!bounds) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.drawImage(
    image,
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height,
  );

  return canvas.toDataURL("image/png");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => resolve(null), { once: true });
    image.src = dataUrl;
  });
}
