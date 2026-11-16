/** Fixture-only DOM boxes; compare positions relative to actual available transcript bounds. */
export async function measureGreetingGeometry(greeting) {
  return greeting.evaluate((copy) => {
    const documentWindow = copy.ownerDocument.defaultView;
    if (!documentWindow) throw new Error("Greeting must belong to a browser document");
    const box = (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const style = documentWindow.getComputedStyle(element);
      return {
        x,
        y,
        width,
        height,
        display: style.display,
        minHeight: style.minHeight,
        padding: style.padding,
        gridRows: style.gridTemplateRows,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
      };
    };
    const surface = copy.parentElement;
    const logo = surface?.querySelector("svg");
    const ancestors = [];
    let element = surface;
    while (element && ancestors.length < 9) {
      ancestors.push({ tag: element.tagName, className: element.className, ...box(element) });
      if (element.hasAttribute("data-parity-client")) break;
      element = element.parentElement;
    }
    return { copy: box(copy), logo: logo ? box(logo) : null, ancestors };
  });
}
