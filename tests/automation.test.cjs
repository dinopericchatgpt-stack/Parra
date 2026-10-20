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

test('reads address headings with edit controls and Croatian labels', () => {
  const api = load('shopify.js', ['extractAddressBlock', 'readAddressBlock']);
  for (const heading of ['Shipping address', 'Shipping address Edit', 'Adresa za dostavu:', 'Delivery address']) {
    const block = api.extractAddressBlock([heading, 'Uredi', 'Ana Horvat', 'Ulica 1', '10000 Zagreb', 'Croatia', 'Billing address', 'Other person'], 'Shipping address');
    const address = api.readAddressBlock(block, [], 'shipping');
    assert.equal(address.name, 'Ana Horvat');
    assert.equal(address.city, 'Zagreb');
    assert.ok(!block.includes('Other person'));
  }
});
test('does not invent an address when its heading is absent', () => {
  const api = load('shopify.js', ['extractAddressBlock']);
  assert.equal(api.extractAddressBlock(['Customer', 'Ana Horvat', 'Total', '€40.00'], 'Shipping address'), '');
});

test('reads DOM address when rendered innerText merges heading and address', () => {
  const api = load('shopify.js', ['readAddressSection'], `
    const text = (textContent) => ({nodeType: 3, textContent});
    const title = {innerText: 'Shipping address', childNodes: [text('Shipping address')]};
    const parent = {innerText: 'Shipping addressAna HorvatTestna 110000 ZagrebCroatia',
      childNodes: [title, ...['Ana Horvat', 'Testna 1', '10000 Zagreb', 'Croatia'].map(text)],
      querySelector() {return null;}};
    title.parentElement = parent;
    globalThis.document = {querySelectorAll: () => [title]};
  `);
  assert.equal(api.readAddressSection(['Shipping addressAna Horvat'], 'Shipping address'), 'Ana Horvat\nTestna 1\n10000 Zagreb\nCroatia');
});
test('reads separate billing address and same-as-shipping marker', () => {
  const api = load('shopify.js', ['extractAddressBlock']);
  assert.equal(api.extractAddressBlock(['Billing address', 'Same as shipping address', 'Conversion summary'], 'Billing address'), 'Same as shipping address');
  assert.equal(api.extractAddressBlock(['Billing address', 'Ana Horvat', 'Testna 1', 'Tags'], 'Billing address'), 'Ana Horvat\nTestna 1');
});

test('diagnostic report contains structural counts without customer data', () => {
  const api = load('shopify.js', ['readerDiagnostics'], `
    const title = {tagName: 'H2', childElementCount: 0, innerText: 'Shipping address'};
    const body = {tagName: 'BODY', childElementCount: 1, innerText: 'Shipping address\\nAna Horvat\\nTestna 1\\nBilling address\\nSame as shipping address'};
    title.parentElement = body;
    globalThis.document = {body, querySelectorAll: (selector) => selector === '*' ? [body, title] : []};
  `);
  const report = api.readerDiagnostics();
  assert.match(report, /Dijagnostika 1\.0\.7/);
  assert.match(report, /shipping: tekst=1, redci=1, elementi=1/);
  assert.match(report, /iframe=0; shadow=0/);
  assert.doesNotMatch(report, /Ana|Horvat|Testna|Same as shipping/);
});

test('retains row tax fields for the older Parra layout', async () => {
  const api = load('parra.js', ['fillItemsV2', 'selected'], `
    const selected = [];
    scrollToItemIndex = () => {};
    sleep = async () => {};
    itemControlsByName = () => ({taxPercentage: {name: 'rowTax'}});
    fillControl = () => {};
    chooseControl = async (field, value, warnings, label) => {selected.push(label);};
    waitForTaxExemptionFields = async () => {};
    findTaxExemptionControl = () => ({});
    findReasonControl = () => ({getAttribute() {return "textbox";}});
  `);
  const warnings = [];
  await api.fillItemsV2({items: [{name:'Majica', unitPrice:'20.00', quantity:'1'}]}, warnings, false);
  assert.ok(api.selected.includes('PDV stavke 1'));
  assert.ok(api.selected.includes('Osnova oslobodenja stavke 1'));
  assert.deepEqual(warnings, []);
});

test('does not assume global tax exemption if the shared controls do not exist', async () => {
  const api = load('parra.js', ['fillInvoiceTaxExemption'], 'sectionControls = () => [];');
  const warnings = [];
  assert.equal(await api.fillInvoiceTaxExemption(warnings), false);
  assert.deepEqual(warnings, []);
});

function popupWithParraVersion(parraVersion) {
  const sent = [];
  const element = {addEventListener() {}};
  const context = {
    document: {getElementById: () => element, querySelector: () => element},
    chrome: {
      runtime: {getManifest: () => ({version: '1.0.7'})},
      tabs: {
        query: async () => [{id: 42}],
        sendMessage: async (id, message) => {
          sent.push(message.action);
          return message.action === 'GET_PARRA_VERSION' ? (parraVersion ? {parraVersion} : undefined) : {ok:true};
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8') + '\nglobalThis.send = sendActionToActiveTab;', context);
  return {send:context.send, sent};
}

test('blocks filling with stale or unidentified Parra scripts before changing the form', async () => {
  for (const version of ['1.0.5', undefined]) {
    const popup = popupWithParraVersion(version);
    await assert.rejects(popup.send('FILL_PARRA_FORM'), /Osvjezi Parra karticu/);
    assert.deepEqual(popup.sent, ['GET_PARRA_VERSION']);
  }
});

test('fills only after the Parra script reports the installed extension version', async () => {
  const popup = popupWithParraVersion('1.0.7');
  await popup.send('FILL_PARRA_FORM');
  assert.deepEqual(popup.sent, ['GET_PARRA_VERSION', 'FILL_PARRA_FORM']);
});
