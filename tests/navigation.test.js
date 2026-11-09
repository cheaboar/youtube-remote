const test = require("node:test");
const assert = require("node:assert/strict");
const { groupRows, nextItem } = require("../navigation.js");

function item(name, left, top, width = 100, height = 80) {
  return { element: name, rect: { left, top, width, height } };
}

test("groups cards by top edge and sorts each row left to right", () => {
  const cards = [item("d", 120, 102), item("b", 120, 3), item("c", 0, 100), item("a", 0, 0)];
  assert.deepEqual(groupRows(cards).map((row) => row.map((card) => card.element)), [["a", "b"], ["c", "d"]]);
});

test("starts at the first card and stops at horizontal boundaries", () => {
  const cards = [item("a", 0, 0), item("b", 120, 0)];
  assert.equal(nextItem(cards, null, "ArrowDown").element, "a");
  assert.equal(nextItem(cards, "a", "ArrowLeft").element, "a");
  assert.equal(nextItem(cards, "a", "ArrowRight").element, "b");
  assert.equal(nextItem(cards, "b", "ArrowRight").element, "b");
  assert.equal(nextItem([], null, "ArrowDown"), null);
});

test("moves vertically to the closest column and stops at vertical boundaries", () => {
  const cards = [item("a", 0, 0), item("b", 120, 0), item("c", 240, 0), item("d", 0, 100), item("e", 150, 100)];
  assert.equal(nextItem(cards, "c", "ArrowDown").element, "e");
  assert.equal(nextItem(cards, "e", "ArrowUp").element, "b");
  assert.equal(nextItem(cards, "a", "ArrowUp").element, "a");
  assert.equal(nextItem(cards, "e", "ArrowDown").element, "e");
});

test("starts again when the selected card no longer exists", () => {
  const cards = [item("a", 0, 0), item("b", 120, 0)];
  assert.equal(nextItem(cards, "removed", "ArrowRight").element, "a");
});
