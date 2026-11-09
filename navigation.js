(function (root, factory) {
  const navigation = factory();
  if (typeof module === "object" && module.exports) module.exports = navigation;
  else root.YouTubeKeyboardNavigation = navigation;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  // A small top-edge tolerance accommodates cards with different title heights.
  function groupRows(items) {
    const sorted = [...items].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
    const rows = [];
    for (const item of sorted) {
      const row = rows[rows.length - 1];
      const tolerance = Math.min(50, Math.max(12, item.rect.height * 0.2));
      if (!row || Math.abs(item.rect.top - row.top) > tolerance) {
        rows.push({ top: item.rect.top, items: [item] });
      } else {
        row.items.push(item);
      }
    }
    return rows.map((row) => row.items.sort((a, b) => a.rect.left - b.rect.left));
  }

  function nextItem(items, selected, direction) {
    if (!items.length) return null;
    const rows = groupRows(items);
    const rowIndex = rows.findIndex((row) => row.some((item) => item.element === selected));
    if (rowIndex < 0) return rows[0][0];

    const row = rows[rowIndex];
    const column = row.findIndex((item) => item.element === selected);
    if (direction === "ArrowLeft") return row[Math.max(0, column - 1)];
    if (direction === "ArrowRight") return row[Math.min(row.length - 1, column + 1)];

    const nextRow = rows[rowIndex + (direction === "ArrowUp" ? -1 : 1)];
    if (!nextRow) return row[column];
    const center = row[column].rect.left + row[column].rect.width / 2;
    return nextRow.reduce((nearest, item) => {
      const distance = Math.abs(item.rect.left + item.rect.width / 2 - center);
      const bestDistance = Math.abs(nearest.rect.left + nearest.rect.width / 2 - center);
      return distance < bestDistance ? item : nearest;
    });
  }

  return { groupRows, nextItem };
});
