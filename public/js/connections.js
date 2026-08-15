const SVG_NS = 'http://www.w3.org/2000/svg';

// Draws a line between the center of each connected pair of cards, in an
// SVG overlay absolutely positioned over the card grid. Coordinates are
// computed from getBoundingClientRect relative to the grid wrapper, so this
// must be re-run on resize and whenever the card layout changes.
export function drawConnectionLines(svgEl, wrapEl, connections, cardsById) {
  svgEl.innerHTML = '';
  const wrapRect = wrapEl.getBoundingClientRect();
  svgEl.setAttribute('width', wrapRect.width);
  svgEl.setAttribute('height', wrapRect.height);

  for (const conn of connections) {
    const fromCard = cardsById.get(conn.from);
    const toCard = cardsById.get(conn.to);
    if (!fromCard || !toCard) continue;

    const a = fromCard.getBoundingClientRect();
    const b = toCard.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - wrapRect.left;
    const y1 = a.top + a.height / 2 - wrapRect.top;
    const x2 = b.left + b.width / 2 - wrapRect.left;
    const y2 = b.top + b.height / 2 - wrapRect.top;

    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('stroke', 'var(--accent)');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '5 4');
    line.setAttribute('opacity', '0.55');
    svgEl.appendChild(line);
  }
}

// Builds a map of serviceId -> Set of connected serviceIds (both directions).
export function buildAdjacency(connections) {
  const adjacency = new Map();
  for (const conn of connections) {
    if (!adjacency.has(conn.from)) adjacency.set(conn.from, new Set());
    if (!adjacency.has(conn.to)) adjacency.set(conn.to, new Set());
    adjacency.get(conn.from).add(conn.to);
    adjacency.get(conn.to).add(conn.from);
  }
  return adjacency;
}

export function highlightNeighbors(cardsById, adjacency, serviceId) {
  const neighbors = adjacency.get(serviceId) || new Set();
  for (const [id, card] of cardsById) {
    if (id === serviceId || neighbors.has(id)) {
      card.classList.remove('dimmed');
      if (id !== serviceId) card.classList.add('connection-highlight');
    } else {
      card.classList.add('dimmed');
    }
  }
}

export function clearHighlight(cardsById) {
  for (const card of cardsById.values()) {
    card.classList.remove('dimmed', 'connection-highlight');
  }
}
