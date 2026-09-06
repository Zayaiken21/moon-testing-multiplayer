/**
 * store.js — the Voxelia shop, kept deliberately separate.
 *
 * Drop this next to voxelia.html in your GitHub Pages repo and add one line
 * to the page:
 *
 *     <script src="store.js"></script>
 *
 * The game runs perfectly without it. When it is present, a Store button
 * appears on the title screen. Edit CATALOGUE and CHECKOUT below and nothing
 * in the game itself has to change.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. What you sell. Edit freely.                                      *
   * ------------------------------------------------------------------ */
  const CATALOGUE = [
    {
      id: 'supporter',
      name: 'Supporter Badge',
      price: '$2.99',
      blurb: 'A coloured name tag above your head in multiplayer.',
      swatch: '#6FE3C4',
      grants: { badge: 'supporter' }
    },
    {
      id: 'skinpack-explorer',
      name: 'Explorer Skin Pack',
      price: '$3.99',
      blurb: 'Six character looks: diver, ranger, pilot, botanist, miner, drifter.',
      swatch: '#A97BFF',
      grants: { skins: ['diver', 'ranger', 'pilot', 'botanist', 'miner', 'drifter'] }
    },
    {
      id: 'lantern-set',
      name: 'Lantern Set',
      price: '$1.99',
      blurb: 'Four decorative lamp blocks in warm, cold, coral and violet.',
      swatch: '#FFC24C',
      grants: { blocks: ['warm lantern', 'cold lantern', 'coral lantern', 'violet lantern'] }
    },
    {
      id: 'room-slots',
      name: 'Extra Room Slots',
      price: '$4.99',
      blurb: 'Host up to 32 players instead of 8.',
      swatch: '#FF8A4C',
      grants: { maxPlayers: 32 }
    }
  ];

  /* ------------------------------------------------------------------ *
   * 2. Checkout. Point this at Stripe, Gumroad, Ko-fi, anything.        *
   *    Return true if the purchase went through.                        *
   * ------------------------------------------------------------------ */
  async function CHECKOUT(item) {
    // Replace this with your own payment link or API call, for example:
    //   window.open('https://buy.stripe.com/your-link?item=' + item.id, '_blank');
    //   return false;   // entitlement arrives from your webhook instead
    window.alert(
      'Checkout is not wired up yet.\n\n' +
      item.name + ' — ' + item.price + '\n\n' +
      'Open store.js and point CHECKOUT() at your payment provider.'
    );
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 3. What the player owns, kept on their device.                      *
   * ------------------------------------------------------------------ */
  const OWNED_KEY = 'voxelia.store.owned';

  function owned() {
    try { return JSON.parse(localStorage.getItem(OWNED_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function grant(id) {
    try {
      const list = owned();
      if (list.indexOf(id) === -1) list.push(id);
      localStorage.setItem(OWNED_KEY, JSON.stringify(list));
    } catch (e) { /* private browsing: the purchase still stands on your server */ }
  }

  /** Anything else on the page can ask what this player has bought. */
  window.VoxeliaStore = {
    owns: (id) => owned().indexOf(id) >= 0,
    all: () => owned().slice(),
    catalogue: () => CATALOGUE.slice(),
    grant
  };

  /* ------------------------------------------------------------------ *
   * 4. The panel itself.                                                *
   * ------------------------------------------------------------------ */
  const CSS = `
  #store-screen{position:fixed;inset:0;z-index:80;display:none;overflow:auto;
    background:linear-gradient(180deg, rgba(14,12,22,.62), rgba(14,12,22,.93));
    backdrop-filter:blur(7px);-webkit-backdrop-filter:blur(7px);
    padding:max(16px, env(safe-area-inset-top)) 16px 26px}
  #store-screen.open{display:block}
  #store-screen .store-sheet{max-width:620px;margin:0 auto;background:#1E1B2B;
    border:1px solid #332E47;border-radius:18px;padding:22px;color:#EDE9F5;
    font-family:ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    box-shadow:0 18px 60px rgba(0,0,0,.5)}
  #store-screen h2{font-family:"Chakra Petch", ui-sans-serif, system-ui, sans-serif;
    font-size:22px;margin:0 0 4px}
  #store-screen p.note{color:#9C93B5;font-size:13.5px;line-height:1.5;margin:0 0 18px}
  .store-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
  .store-item{display:flex;gap:11px;align-items:flex-start;background:#262236;
    border:1px solid #332E47;border-radius:12px;padding:12px}
  .store-item .chip{width:38px;height:38px;border-radius:9px;flex:none}
  .store-item strong{display:block;font-size:14px;margin-bottom:2px}
  .store-item small{display:block;color:#9C93B5;font-size:11.5px;line-height:1.4}
  .store-item button{margin-top:8px;background:#6FE3C4;color:#0C2620;border:none;
    border-radius:8px;padding:7px 13px;font-size:12.5px;cursor:pointer;
    font-family:"Chakra Petch", ui-sans-serif, system-ui, sans-serif}
  .store-item button:disabled{background:#332E47;color:#9C93B5;cursor:default}
  #store-screen .store-close{background:#262236;border:1px solid #332E47;color:#EDE9F5;
    border-radius:9px;padding:11px 15px;cursor:pointer;margin-top:18px;
    font-family:"Chakra Petch", ui-sans-serif, system-ui, sans-serif;font-size:14px}
  #open-store{text-align:center}
  `;

  function build() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const screen = document.createElement('section');
    screen.id = 'store-screen';
    screen.innerHTML =
      '<div class="store-sheet">' +
        '<h2>Store</h2>' +
        '<p class="note">Optional extras. Nothing here changes how the world generates ' +
        'or gives an advantage in multiplayer.</p>' +
        '<div class="store-grid" id="store-grid"></div>' +
        '<button class="store-close" id="store-close">Close</button>' +
      '</div>';
    document.body.appendChild(screen);

    document.getElementById('store-close').addEventListener('click', close);
    render();
  }

  function render() {
    const grid = document.getElementById('store-grid');
    grid.innerHTML = '';
    CATALOGUE.forEach((item) => {
      const has = window.VoxeliaStore.owns(item.id);
      const el = document.createElement('div');
      el.className = 'store-item';
      el.innerHTML =
        '<div class="chip" style="background:' + item.swatch + '"></div>' +
        '<div><strong>' + item.name + '</strong>' +
        '<small>' + item.blurb + '</small>' +
        '<button' + (has ? ' disabled' : '') + '>' +
        (has ? 'Owned' : item.price) + '</button></div>';
      const btn = el.querySelector('button');
      if (!has) {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Working…';
          let ok = false;
          try { ok = await CHECKOUT(item); } catch (e) { ok = false; }
          if (ok) { grant(item.id); render(); }
          else { btn.disabled = false; btn.textContent = item.price; }
        });
      }
      grid.appendChild(el);
    });
  }

  function open() { document.getElementById('store-screen').classList.add('open'); render(); }
  function close() { document.getElementById('store-screen').classList.remove('open'); }
  window.VoxeliaStore.open = open;
  window.VoxeliaStore.close = close;

  /* ------------------------------------------------------------------ *
   * 5. Slot a Store button onto the title screen, if one is there.      *
   * ------------------------------------------------------------------ */
  function attach() {
    build();
    const row = document.querySelector('#home .minor-row');
    if (!row) return;                       // the game page changed; the panel still works
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.id = 'open-store';
    btn.textContent = 'Store';
    btn.addEventListener('click', open);
    row.appendChild(btn);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})();
