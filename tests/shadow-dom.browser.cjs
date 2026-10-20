// Pokreni s instaliranim Playwrightom i Chromiumom:
// node --test tests/shadow-dom.browser.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

test('saves buyer, addresses, two products and paid shipping across nested shadow roots', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>
      <h1>#1745</h1>
      <div><div>Test majica</div><div>White / S STTU170TEST</div><div>€20.00 × 1</div><div>€20.00</div></div>
      <div><div>Druga majica</div><div>Black / XL STTU169TEST</div><div>€25.00 × 1</div><div>€25.00</div></div>
      <section><h2>Paid</h2><div>Subtotal</div><div>2 items</div><div>€45.00</div><div>Shipping</div><div>Dostava na adresu (0.5 kg: Items 0.5 kg, Package 0.0 kg)</div><div>€5.00</div><div>Total</div><div>€50.00</div></section>
    </body></html>`);
    await page.evaluate(() => {
      function component(tag, html) {
        const el = document.createElement(tag);
        el.attachShadow({ mode: 'open' }).innerHTML = html;
        return el;
      }
      const panel = component('s-contact', '<section id="content"></section>');
      const customer = component('s-customer', '<h2>Customer</h2><a href="/store/test/customers/123">Ana Horvat</a><div>1 order</div><div>ana@example.test</div>');
      const shipping = component('s-address', '<h2>Shipping address</h2><slot name="address"></slot><a>View map</a>');
      const address = document.createElement('p');
      address.slot = 'address';
      address.innerHTML = 'Ana Horvat<br>Testna ulica 53<br>21312 Testni Grad<br>Croatia<br>+385 91 000 0000';
      shipping.append(address);
      const billing = component('s-billing', '<h2>Billing address</h2><p>Same as shipping address</p>');
      panel.shadowRoot.querySelector('#content').append(customer, shipping, billing);
      document.body.append(panel);
      // Jednaki podaci u light DOM-u moraju se procitati samo kroz slot.
      window.saved = null;
      window.chrome = {
        runtime: { onMessage: { addListener(fn) { window.saveListener = fn; } } },
        storage: { local: { async set(value) { window.saved = value; } } }
      };
    });
    await page.addScriptTag({content: fs.readFileSync(process.env.PARRA_SHOPIFY_SCRIPT || path.join(__dirname, '..', 'shopify.js'), 'utf8')});
    const result = await page.evaluate(() => new Promise((resolve) => window.saveListener({action: 'SAVE_SHOPIFY_ORDER'}, {}, resolve)));
    assert.equal(result.ok, true);
    assert.equal(result.order.customerName, 'Ana Horvat');
    assert.equal(result.order.shippingAddress.street, 'Testna ulica 53');
    assert.equal(result.order.shippingAddress.city, 'Testni Grad');
    assert.equal(result.order.billingAddress.name, 'Ana Horvat');
    assert.equal(result.order.email, 'ana@example.test');
    assert.equal(result.order.items.length, 2);
    assert.equal(result.order.shippingCost, '5.00');
    assert.equal(result.order.items.reduce((sum, item) => sum + Number(item.unitPrice.replace('€', '').trim()) * Number(item.quantity), 0) + Number(result.order.shippingCost), 50);
    assert.deepEqual(result.warnings, []);
    const stored = await page.evaluate(() => window.saved.latestOrder);
    assert.deepEqual(stored, result.order);

    // Druga narudzba: zasebna adresa naplate i besplatna dostava.
    await page.evaluate(() => {
      document.querySelector('s-contact').shadowRoot.querySelector('s-billing').shadowRoot.innerHTML =
        '<h2>Billing address</h2><p>Iva Test<br>Druga ulica 10<br>10000 Zagreb<br>Croatia</p><p hidden>Nevidljivi stari kupac</p>';
      Array.from(document.querySelectorAll('div')).find(el => el.textContent === '€5.00').textContent = '€0.00';
    });
    const second = await page.evaluate(() => new Promise((resolve) => window.saveListener({action: 'SAVE_SHOPIFY_ORDER'}, {}, resolve)));
    assert.equal(second.order.customerName, 'Iva Test');
    assert.equal(second.order.billingAddress.street, 'Druga ulica 10');
    assert.equal(second.order.shippingAddress.name, 'Ana Horvat');
    assert.equal(second.order.shippingCost, '0.00');
    assert.doesNotMatch(second.order.billingAddress.full, /Nevidljivi/);
    assert.deepEqual(second.warnings, []);
  } finally {
    await browser.close();
  }
});
