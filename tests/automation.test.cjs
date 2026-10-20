const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function load(file, names, setup = "") {
  const context = { chrome: { runtime: { onMessage: { addListener() {} } } } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `${setup}; globalThis.api = {${names.join(',')}};})();`), context);
  return context.api;
}
const shopify = load('shopify.js', ['readShippingCost']);
const parra = load('parra.js', ['invoiceItems', 'discountPercentForItem', 'formatCroatianDate']);
test('reads shipping from same line or separate summary lines', () => {
  for (const text of ['Shipping €4.50', 'Shipping\nStandard delivery\n€4.50', 'Dostava\n4,50 €']) {
    assert.equal(shopify.readShippingCost(text).replace(',', '.'), '4.50');
  }
});
test('free or missing shipping never uses the total or address', () => {
  for (const text of ['Shipping\nFree\nTotal\n€45.00', 'Shipping\nTotal\n€45.00', 'Shipping address\nTest kupac\nTotal €45.00']) {
    assert.ok(!Number(shopify.readShippingCost(text)));
  }
});
test('adds paid delivery exactly once without changing the saved items', () => {
  const order = {items: [{name: 'Majica', unitPrice: '20.00', quantity: '1'}], shippingCost: '4,50 €', discountCode: 'WELCOME10'};
  const result = parra.invoiceItems(order);
  assert.equal(result.length, 2);
  assert.equal(result[1].name, 'Dostava');
  assert.equal(result[1].unitPrice, '4.50');
  assert.equal(parra.discountPercentForItem(result[1], order), '0');
  assert.equal(parra.discountPercentForItem(result[0], order), '10,00');
  assert.equal(parra.invoiceItems(order).length, 2);
  assert.equal(order.items.length, 1);
});
test('does not add zero, missing or negative delivery', () => {
  for (const shippingCost of ['', '0.00', '-4.50']) assert.equal(parra.invoiceItems({items: [], shippingCost}).length, 0);
});
test('formats the selected local day without moving it to another date', () => {
  assert.equal(parra.formatCroatianDate(new Date(2026, 9, 20)), '20.10.2026.');
});

test('writes buyer name after customer type changes and clears previous input', async () => {
  const api = load('parra.js', ['fillBuyer', 'events'], `
    const events = [];
    const nameField = { labels: [{textContent: 'Ime i prezime'}], getAttribute() {return '';}};
    sectionControls = () => [nameField];
    controlByName = () => null;
    chooseControl = async (control, value) => {events.push(value);};
    sleep = async () => {};
    clearControl = () => {};
    fillControl = (field, value, warnings, label) => { if(label === 'Ime i prezime kupca') events.push(value); };
  `);
  await api.fillBuyer({customerName: 'Ana Horvat', shippingAddress: {}}, []);
  assert.equal(api.events[0], 'Fizicka osoba');
  assert.equal(api.events[1], 'Ana Horvat');
});
test('uses single delivery date and overwrites an existing old date with today', async () => {
  const api = load('parra.js', ['fillDelivery', 'field', 'formatCroatianDate'], `
    const field = {value: '01.01.2020.', type: 'text', blur() {}};
    sectionScope = () => ({});
    findVisibleText = () => ({closest: () => null, click() {}});
    sleep = async () => {};
    sectionControls = () => [field];
    controlByName = () => field;
    fillControl = (target, value) => { target.value = value; };
  `);
  const warnings = [];
  await api.fillDelivery(warnings);
  assert.equal(api.field.value, api.formatCroatianDate(new Date()));
  assert.equal(warnings.length, 0);
});
