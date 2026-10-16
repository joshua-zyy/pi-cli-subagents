// The row-budget arithmetic the agent roster and the role editor both draw their lists with.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fitSelection } from '../dist/ui/format.js';

// Rows a pane really draws: the selectable run plus each marker that still had room for one row.
const rendering = fit => {
  let spare = fit.spare, rows = fit.visible;
  if (fit.above > 0 && spare > 0) { spare--; rows++; }
  if (fit.below > 0 && spare > 0) rows++;
  return rows;
};
// The two callers' opening bounds: the roster keeps one row at a zero budget and crops afterwards,
// the role editor budgets exactly and never crops.
const rosterOpening = (itemCount, budget, maxRows) => Math.max(1, Math.min(maxRows, itemCount, budget));
const editorOpening = (itemCount, budget) => Math.min(itemCount, budget);

test('a list that fits renders whole, with the leftover rows reported as spare', () => {
  const fit = fitSelection(3, 1, 5, rosterOpening(3, 5, 3));
  assert.deepEqual(fit, { start: 0, visible: 3, above: 0, below: 0, spare: 2 });
});

test('a scroll marker is paid for by dropping a selectable row, never added on top of the budget', () => {
  // Selected at the end of 12 items in a 4-row budget: 4 rows up to index 7 would already need a
  // marker, so the window shrinks to 3 rows and spends the freed row on the marker itself.
  const atEnd = fitSelection(12, 11, 4, editorOpening(12, 4));
  assert.deepEqual(atEnd, { start: 9, visible: 3, above: 9, below: 0, spare: 1 });
  assert.equal(rendering(atEnd), 4);
  // Selected in the middle: both markers fit only after the window shrinks twice.
  const middle = fitSelection(12, 5, 4, editorOpening(12, 4));
  assert.deepEqual(middle, { start: 4, visible: 2, above: 4, below: 6, spare: 2 });
  assert.equal(rendering(middle), 4);
  // Selected at the start: the window stops at the first item instead of scrolling.
  const atStart = fitSelection(12, 0, 3, editorOpening(12, 3));
  assert.deepEqual(atStart, { start: 0, visible: 2, above: 0, below: 10, spare: 1 });
  assert.equal(rendering(atStart), 3);
});

test("the roster's opening bound still draws one selectable row at a zero budget and then shows no marker", () => {
  const fit = fitSelection(12, 5, 0, rosterOpening(12, 0, 8));
  assert.equal(fit.visible, 1, 'the roster keeps one row before headers even with no budget left');
  assert.equal(fit.spare, -1);
  assert.equal(rendering(fit), 1, 'a negative spare suppresses both markers');
});

test("the role editor's opening bound renders nothing when the budget is gone", () => {
  const fit = fitSelection(12, 5, 0, editorOpening(12, 0));
  assert.equal(fit.visible, 0);
  assert.equal(rendering(fit), 0);
});

test('every window keeps the selected row on screen and stays inside its row budget', () => {
  for (const opening of [rosterOpening, editorOpening]) {
    for (let itemCount = 0; itemCount <= 15; itemCount++) {
      for (let budget = 0; budget <= 12; budget++) {
        for (let selected = 0; selected < Math.max(1, itemCount); selected++) {
          const fit = fitSelection(itemCount, selected, budget, opening(itemCount, budget, 4));
          const at = `items=${itemCount} selected=${selected} budget=${budget}`;
          if (fit.visible > 0) {
            assert.ok(fit.start <= selected, `selection above the window at ${at}`);
            assert.ok(fit.start + fit.visible > selected, `selection below the window at ${at}`);
          }
          assert.ok(fit.visible <= budget || budget === 0, `window wider than its budget at ${at}`);
          assert.ok(rendering(fit) <= Math.max(budget, 1), `rows drawn past the budget at ${at}`);
        }
      }
    }
  }
});
