const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

for (const usePlaceholder of [false, true]) test(`uses invoice exemption dropdowns identified by ${usePlaceholder ? 'placeholder' : 'name'} without obsolete tax warnings`, async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>
      input {height: 28px; width: 160px} .row {height: 220px} .product {width: 400px}
      .line {display:flex; gap:20px; margin:10px} [role=listbox] {position:fixed;top:0;left:0;background:white;z-index:9999}
      </style><h2>Osnovni podaci</h2>
      <input name="paymentMethod" role="combobox" value="Kartica">
      <input name="taxExcludeBasis" role="combobox">
      <input name="taxExcludeReason" role="combobox">
      <h2>Isporuka</h2><input name="deliveryDate">
      <h2>Stavke</h2><section id="rows"></section><button type="button" id="add">Dodaj stavku</button><h2>Dodatno</h2>`);
    await page.evaluate((usePlaceholder) => {
      if (usePlaceholder) {
        for (const name of ['taxExcludeBasis', 'taxExcludeReason']) {
          const field = document.querySelector(`[name=${name}]`);
          field.setAttribute('placeholder', name);
          field.name = `generated-${name}`;
        }
      }
      const getTaxField = name => document.querySelector(`[name=${name}], [placeholder=${name}]`);
      window.selectedOptions = [];
      function dropdown(input, text, afterSelect) {
        input.addEventListener('click', () => {
          document.querySelector('[role=listbox]')?.remove();
          const list = document.createElement('div'); list.setAttribute('role', 'listbox');
          const option = document.createElement('div'); option.setAttribute('role', 'option'); option.textContent = text;
          option.onclick = () => {input.value = text; window.selectedOptions.push(input.getAttribute('placeholder') || input.name); list.remove(); afterSelect?.();};
          list.append(option);
          if (text.startsWith('Prijenos porezne obveze')) {
            for (const wrongText of ['PDV nije obračunat prema čl. 90 st. 1 i st. 2 Zakona o PDV-u', 'Prijenos porezne obveze prema čl. 17 st. 2 Zakona o PDV-u']) {
              const wrong = document.createElement('div'); wrong.setAttribute('role', 'option'); wrong.textContent = wrongText;
              wrong.onclick = () => {input.value = wrongText; list.remove();}; list.append(wrong);
            }
          }
          document.body.append(list);
        });
      }
      const reasonText = 'Prijenos porezne obveze prema čl. 17 st. 1 Zakona o PDV-u' + (usePlaceholder ? ' — testni dodatak za provjeru dugackog teksta opcije koja prelazi sto znakova' : '');
      function resetReason() {
        const old = getTaxField('taxExcludeReason');
        const fresh = old.cloneNode(); fresh.value = ''; old.replaceWith(fresh);
        dropdown(fresh, reasonText);
      }
      dropdown(getTaxField('taxExcludeBasis'), 'Ne podliježe', resetReason);
      resetReason();
      function addRow() {
        const row = document.createElement('article'); row.className = 'row';
        row.innerHTML = `<div class="line"><input class="product" role="combobox"><input name="quantity" role="spinbutton"><input name="unit" role="combobox" value="komad"></div>
          <div class="line"><input name="unitPrice" role="spinbutton"><input name="discountRate" role="spinbutton"></div><div class="line"><input name="kpdMark" role="combobox"></div>`;
        document.querySelector('#rows').append(row);
      }
      document.querySelector('#add').onclick = addRow; addRow();
      window.chrome = {runtime: {onMessage: {addListener() {}}}};
    }, usePlaceholder);
    const source = fs.readFileSync(process.env.PARRA_FORM_SCRIPT || path.join(__dirname, '..', 'parra.js'), 'utf8');
    await page.addScriptTag({content: source.replace(/\}\)\(\);\s*$/, 'sleep = async () => {}; globalThis.parraTest = {fillBasics, fillItemsV2, fillInvoiceTaxExemption};})();')});
    const result = await page.evaluate(async () => {
      const warnings = [];
      const globalTax = await window.parraTest.fillBasics(warnings);
      await window.parraTest.fillItemsV2({items: [{name: 'Majica A', quantity:'1',unitPrice:'20.00'}, {name:'Majica B',quantity:'1',unitPrice:'25.00'}],shippingCost:'5.00'}, warnings, globalTax);
      return {warnings, globalTax, selected: window.selectedOptions,
        basis: document.querySelector('[name=taxExcludeBasis], [placeholder=taxExcludeBasis]').value,
        reason: document.querySelector('[name=taxExcludeReason], [placeholder=taxExcludeReason]').value,
        rows: Array.from(document.querySelectorAll('.row')).map(row => ({name: row.querySelector('.product').value, price: row.querySelector('[name=unitPrice]').value}))};
    });
    assert.equal(result.globalTax, true);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.selected, ['taxExcludeBasis', 'taxExcludeReason']);
    assert.equal(result.basis, 'Ne podliježe');
    assert.match(result.reason, /čl\. 17 st\. 1/);
    assert.deepEqual(result.rows, [{name:'Majica A',price:'20,00'}, {name:'Majica B',price:'25,00'}, {name:'Dostava',price:'5,00'}]);

    // Nepoznata ponudena opcija mora ostati vidljivo upozorenje.
    await page.evaluate(() => {
      const field = document.querySelector('[name=taxExcludeReason], [placeholder=taxExcludeReason]');
      field.value = '';
      field.addEventListener('click', () => {
        document.querySelector('[role=option]').textContent = 'Drugi zakonski razlog';
      });
    });
    const warnings = await page.evaluate(async () => {const warnings = []; await window.parraTest.fillInvoiceTaxExemption(warnings); return warnings;});
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Nisam pronasao ponudenu opciju za Razlog oslobodenja racuna/);

    // Dvije opcije s istim pocetkom ne smiju se odabrati nasumicno.
    await page.evaluate(() => {
      const old = document.querySelector('[name=taxExcludeReason], [placeholder=taxExcludeReason]');
      const fresh = old.cloneNode(); fresh.value = ''; old.replaceWith(fresh);
      fresh.addEventListener('click', () => {
        document.querySelector('[role=listbox]')?.remove();
        const list = document.createElement('div'); list.setAttribute('role', 'listbox');
        for (const suffix of ['PDV-u, opcija A', 'PDV-u, opcija B']) {
          const option = document.createElement('div'); option.setAttribute('role', 'option');
          option.textContent = 'Prijenos porezne obveze prema čl. 17 st. 1 Zakona o ' + suffix;
          option.onclick = () => {window.selectedOptions.push('ambiguous');}; list.append(option);
        }
        document.body.append(list);
      });
    });
    const ambiguous = await page.evaluate(async () => {
      const warnings = []; await window.parraTest.fillInvoiceTaxExemption(warnings);
      return {warnings, selected: window.selectedOptions};
    });
    assert.equal(ambiguous.warnings.length, 1);
    assert.ok(!ambiguous.selected.includes('ambiguous'));
  } finally { await browser.close(); }
});
