(function () {
  // Parra autofill radi samo na klik iz popupa.
  // Ne klika "Izdaj racun", "Spremi nacrt" ni submit gumbe.

  const STORAGE_KEY = "latestOrder";
  const PARRA_VERSION = "1.0.6";

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "GET_PARRA_VERSION") {
      sendResponse({ ok: true, parraVersion: PARRA_VERSION });
      return false;
    }
    if (message.action !== "FILL_PARRA_FORM") {
      return false;
    }

    fillParraFromStorage()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: error.message }));

    return true;
  });

  async function fillParraFromStorage() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const order = result[STORAGE_KEY];

    if (!order) {
      return {
        ok: false,
        message: "Nema spremljene narudzbe. Prvo spremi Shopify narudzbu."
      };
    }

    const warnings = [];

    await fillBuyer(order, warnings);
    const invoiceTaxExemption = await fillBasics(warnings);
    await fillDelivery(warnings);
    await fillItemsV2(order, warnings, invoiceTaxExemption);

    if (warnings.length) {
      warnings.push(makeDebugSummary());
      warnings.push(makeFieldDebug("Kupac polja", sectionControls("Podaci o kupcu", ["Osnovni podaci", "Isporuka", "Stavke"])));
      warnings.push(makeFieldDebug("Osnovni podaci polja", sectionControls("Osnovni podaci", ["Isporuka", "Stavke", "Dodatno"])));
      warnings.push(makeFieldDebug("Isporuka polja", sectionControls("Isporuka", ["Stavke", "Dodatno"])));
      warnings.push(makeFieldDebug("Stavke polja", sectionControls("Stavke", ["Dodatno"])));
    }

    return { ok: true, parraVersion: PARRA_VERSION, warnings };
  }

  async function fillBuyer(order, warnings) {
    const fields = sectionControls("Podaci o kupcu", ["Osnovni podaci", "Isporuka", "Stavke"]);
    const address = order.billingAddress?.full ? order.billingAddress : order.shippingAddress || {};
    const contactName = order.customerName || address.name || "";
    const buyerName = contactName;

    await chooseControl(controlByName("customerType") || fields[1], "Fizicka osoba", warnings, "Tip subjekta", ["Fizička osoba", "Privatna osoba"]);
    await sleep(700);

    // Promjena tipa kupca moze ponovno iscrtati polja i obrisati raniji unos.
    const buyerFields = sectionControls("Podaci o kupcu", ["Osnovni podaci", "Isporuka", "Stavke"]);
    const nameField = buyerFields.find((field) => {
      const labels = Array.from(field.labels || []).map((label) => label.textContent).join(" ");
      return /ime.*prezime|naziv kupca|ime kupca|customername|buyername|clientname/i.test(
        [labels, field.getAttribute("name"), field.getAttribute("id"), field.getAttribute("aria-label"), field.getAttribute("placeholder")].join(" ")
      );
    }) || controlByName("clientId") || buyerFields[0];
    fillControl(nameField, buyerName, warnings, "Ime i prezime kupca");

    clearControl(controlByName("vatId") || fields[2]);
    await chooseControl(controlByName("countryId") || fields[3], normalizeCountry(address.country), warnings, "Drzava", ["Hr vatska", "Croatia", "HR"]);
    await sleep(500);
    fillControl(controlByName("email") || fields[6], order.email || "", warnings, "Kontakt email");
    clearControl(controlByName("person") || fields[7]);
  }

  async function fillBasics(warnings) {
    const fields = sectionControls("Osnovni podaci", ["Isporuka", "Stavke", "Dodatno"]);

    // U prikazanoj formi "Nacin placanja" je prvi element u petom redu,
    // odnosno deveto vidljivo polje u sekciji Osnovni podaci.
    await chooseControl(controlByName("paymentMethod") || fields[8], "Kartica", warnings, "Nacin placanja", ["kartica", "Karticno", "Karticno placanje"]);
    return fillInvoiceTaxExemption(warnings);
  }

  function invoiceTaxControls() {
    // Ograniceno na osnovne podatke: ne uzimaj istoimena polja sa stavki.
    const fields = sectionControls("Osnovni podaci", ["Isporuka", "Stavke", "Dodatno"]);
    const byName = (name) => fields.find((field) =>
      ["name", "id", "placeholder", "aria-label"].some((attribute) =>
        normalizeText(field.getAttribute(attribute)) === normalizeText(name)));
    return { basis: byName("taxExcludeBasis"), reason: byName("taxExcludeReason") };
  }

  async function fillInvoiceTaxExemption(warnings) {
    const fields = invoiceTaxControls();
    if (!fields.basis && !fields.reason) return false;
    await chooseControl(fields.basis, "Ne podliježe", warnings, "Osnova oslobodenja racuna", ["Ne podlijeze"], false, true);
    await sleep(300);
    // Osnova moze promijeniti dostupne razloge i ponovno iscrtati polje.
    const reason = invoiceTaxControls().reason;
    const value = "PDV nije obračunat prema čl. 90 st. 1 i st. 2 Zakona o PDV-u";
    if (reason?.getAttribute("role") === "combobox" || reason?.tagName === "SELECT") {
      await chooseControl(reason, value, warnings, "Razlog oslobodenja racuna", [], false, true);
    } else {
      fillControl(reason, value, warnings, "Razlog oslobodenja racuna");
    }
    return true;
  }

  async function fillDelivery(warnings) {
    const scope = sectionScope("Isporuka", ["Stavke", "Dodatno"]);
    const label = findVisibleText(["Datum isporuke"], scope, true);
    const radio = label?.closest("label")?.querySelector("input[type='radio']");
    if (radio) {
      radio.click();
    } else if (label) {
      label.click();
    } else {
      warnings.push("Nisam pronasao opciju Datum isporuke; provjeri nacin isporuke.");
      return;
    }
    await sleep(400);
    const fields = sectionControls("Isporuka", ["Stavke", "Dodatno"]);
    const field = controlByName("deliveryDate") || fields.find(looksLikeDateField);
    if (!field) {
      warnings.push("Nisam pronasao polje Datum isporuke.");
      return;
    }
    const today = new Date();
    const value = field.type === "date"
      ? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
      : formatCroatianDate(today);
    fillControl(field, value, warnings, "Datum isporuke");
    field.blur();
    await sleep(200);
    if (readControl(field).replace(/\s/g, "") !== value) {
      warnings.push("Datum isporuke nije potvrden; odaberi danasnji datum u kalendaru.");
    }
  }

  async function fillItems(order, warnings) {
    const items = invoiceItems(order);

    if (!items.length) {
      warnings.push("Nema stavki za upis.");
      return;
    }

    let rows = itemRows();
    const missingRows = Math.max(0, items.length - rows.length);

    for (let index = 0; index < missingRows; index += 1) {
      const clicked = await clickText("Dodaj stavku", warnings, documentScope());
      if (!clicked) {
        break;
      }

      await sleep(400);
    }

    rows = itemRows();

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const row = rows[index] || [];

      fillControl(row[0], item.name || "", warnings, `Naziv stavke ${index + 1}`);
      fillControl(row[1], normalizeQuantity(item.quantity), warnings, `Kolicina stavke ${index + 1}`);

      // Parra red ima vise polja; cijena i popust su u drugom vizualnom redu
      // iste stavke. Ako je DOM drugaciji, fallback trazi po placeholderu.
      await chooseControl(row[2], "komad", warnings, `Mjerna jedinica stavke ${index + 1}`, ["kom"]);
      fillControl(row[3] || findItemControlByText("Jedinicna cijena", index), moneyToDecimal(item.unitPrice), warnings, `Jedinicna cijena stavke ${index + 1}`);
      fillControl(row[4] || findItemControlByText("Popust", index), discountPercentForItem(item, order), warnings, `Popust stavke ${index + 1}`);
      await chooseControl(row[6] || findItemControlByText("PDV", index), "0%", warnings, `PDV stavke ${index + 1}`, ["0"]);
      await chooseControl(row[7] || findItemControlByText("Osnova oslobodenja", index), "Ne podliježe", warnings, `Osnova oslobodenja stavke ${index + 1}`, ["Ne podlijeze"]);
      fillControl(row[9], item.name || "", warnings, `Razlog oslobodenja stavke ${index + 1}`);
    }
  }

  async function fillItemsV2(order, warnings, invoiceTaxExemption = false) {
    const items = invoiceItems(order);

    if (!items.length) {
      warnings.push("Nema stavki za upis.");
      return;
    }

    for (let index = 0; index < items.length; index += 1) {
      if (index > 0) {
        const beforeCount = sectionControls("Stavke", ["Dodatno"]).length;
        const clicked = await clickAddItemButton(warnings);
        if (!clicked) {
          break;
        }

        await waitForItemControls(beforeCount + 1);
        await waitForItemIndex(index);
      }

      const item = items[index];
      scrollToItemIndex(index);
      await sleep(250);
      const controls = itemControlsByName(index);

      fillControl(controls.product, itemTitleForParra(item), warnings, `Naziv stavke ${index + 1}`);
      fillControl(controls.quantity, normalizeQuantity(item.quantity), warnings, `Kolicina stavke ${index + 1}`);
      await chooseControl(controls.unit, "komad", warnings, `Mjerna jedinica stavke ${index + 1}`, ["kom"], true);
      fillControl(controls.unitPrice, moneyToDecimal(item.unitPrice), warnings, `Jedinicna cijena stavke ${index + 1}`);
      fillControl(controls.discountRate, discountPercentForItem(item, order), warnings, `Popust stavke ${index + 1}`);
      // Novi obrazac ima zajednicko oslobodenje i nema PDV kontrole na stavkama.
      // Kad postoji polje PDV na stavci, zadrzi postupak za stari obrazac.
      if (!controls.taxPercentage && invoiceTaxExemption) continue;
      await chooseControl(controls.taxPercentage, "0%", warnings, `PDV stavke ${index + 1}`, ["0"]);
      await waitForTaxExemptionFields(index);
      await sleep(600);
      scrollToItemIndex(index);
      await chooseControl(findTaxExemptionControl(index), "Ne podlijeze", warnings, `Osnova oslobodenja stavke ${index + 1}`, ["Ne podliježe"]);
      await sleep(300);
      fillControl(findReasonControl(index), "PDV nije obra\u010dunat prema \u010dl. 90 st. 1 i st. 2 Zakona o PDV-u", warnings, `Razlog oslobodenja stavke ${index + 1}`);
    }
  }

  function fillControl(control, value, warnings, label) {
    if (!value) {
      warnings.push(`Nema podatka za ${label}.`);
      return false;
    }

    if (!control) {
      warnings.push(`Nisam pronasao polje: ${label}.`);
      return false;
    }

    const target = focusControl(control);

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

      if (setter) {
        setter.call(target, String(value));
      } else {
        target.value = String(value);
      }
    } else if (target.isContentEditable) {
      target.textContent = String(value);
    } else {
      warnings.push(`Polje nije tekstualni input: ${label}.`);
      return false;
    }

    fireFormEvents(target, value);
    return true;
  }

  function clearControl(control) {
    if (!control) {
      return;
    }

    const target = focusControl(control);

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

      if (setter) {
        setter.call(target, "");
      } else {
        target.value = "";
      }

      fireFormEvents(target, "");
    }
  }

  async function chooseControl(control, value, warnings, label, fallbacks = [], allowUnverified = false, requireOption = false) {
    if (!control) {
      warnings.push(`Nisam pronasao dropdown: ${label}.`);
      return false;
    }

    const alreadySelected = requireOption
      ? [value, ...fallbacks].some((option) => normalizeText(readControl(control)) === normalizeText(option))
      : controlLooksSelected(control, value) || fallbacks.some((fallback) => controlLooksSelected(control, fallback));
    if (alreadySelected) {
      return true;
    }

    const options = [value, ...fallbacks];
    const optionScope = requireOption ? {
      querySelectorAll() { return documentScope().querySelectorAll("[role='option'], [role='listbox'] li"); }
    } : documentScope();
    let target = focusControl(control);

    for (const optionText of options) {
      openDropdown(target);
      await sleep(250);

      let option = findVisibleText([optionText], optionScope, true);

      if (!option) {
        typeIntoCombobox(target, optionText);
        await sleep(500);
        option = findVisibleText([optionText], optionScope, true);
      }

      if (option && !isSubmitLike(option)) {
        option.click();
        option.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(250);

        if (controlLooksSelected(control, optionText) || controlLooksSelected(target, optionText)) {
          return true;
        }

        return true;
      }
    }

    if (requireOption) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      warnings.push(`Nisam pronasao ponudenu opciju za ${label}: ${value}. Provjeri odabir rucno.`);
      return false;
    }

    target = focusControl(control);
    typeIntoCombobox(target, value);
    await sleep(300);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    await sleep(250);

    if (controlLooksSelected(control, value) || controlLooksSelected(target, value)) {
      return true;
    }

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
    await sleep(100);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(250);

    if (!allowUnverified) {
      warnings.push(`Nisam siguran da je dropdown odabran: ${label}.`);
    }

    return true;
  }

  async function waitForSelection(control, values, timeoutMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (values.some((value) => controlLooksSelected(control, value))) {
        return true;
      }

      await sleep(150);
    }

    return false;
  }

  function openDropdown(target) {
    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus();
    const rect = target.getBoundingClientRect();
    clickAt(target, Math.max(rect.left + 4, rect.right - 18), rect.top + rect.height / 2);
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
  }

  function typeIntoCombobox(target, value) {
    target.focus();

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.select();
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", bubbles: true }));

      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

      if (setter) {
        setter.call(target, "");
      } else {
        target.value = "";
      }

      fireFormEvents(target, "");

      if (setter) {
        setter.call(target, String(value));
      } else {
        target.value = String(value);
      }

      fireFormEvents(target, value);
      target.dispatchEvent(new KeyboardEvent("keydown", { key: value.slice(-1) || "a", bubbles: true }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: value.slice(-1) || "a", bubbles: true }));
      return;
    }

    target.textContent = String(value);
    fireFormEvents(target, value);
  }

  function controlLooksSelected(control, value) {
    const expected = normalizeText(value);
    const actual = normalizeText([
      readControl(control),
      control?.innerText,
      control?.textContent
    ].filter(Boolean).join(" "));

    return actual && (actual.includes(expected) || expected.includes(actual));
  }

  async function clickText(text, warnings, scope) {
    const element = findVisibleText([text], scope);

    if (!element || isSubmitLike(element)) {
      warnings.push(`Nisam pronasao: ${text}.`);
      return false;
    }

    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);
    return true;
  }

  async function clickAddItemButton(warnings) {
    const scope = sectionScope("Stavke", ["Dodatno"]);
    const button = scope.querySelectorAll("button, [role='button']")
      .filter((element) => !isSubmitLike(element))
      .find((element) => normalizeText(element.innerText || element.textContent || "").includes("dodaj stavku"));

    if (!button) {
      warnings.push("Nisam pronasao gumb Dodaj stavku.");
      return false;
    }

    button.scrollIntoView({ block: "center", inline: "center" });
    await sleep(100);
    button.click();
    return true;
  }

  async function clickDeliveryPeriod(warnings) {
    const scope = sectionScope("Isporuka", ["Stavke", "Dodatno"]);
    const radioClicked = await clickSecondDeliveryRadio(scope);

    if (radioClicked) {
      return true;
    }

    const label = findVisibleText(["Period isporuke"], scope);

    if (!label) {
      warnings.push("Nisam pronasao opciju Period isporuke.");
      return false;
    }

    const labelRect = label.getBoundingClientRect();
    label.scrollIntoView({ block: "center", inline: "center" });
    await sleep(100);

    // Parra radio kontrola je mali krug lijevo od teksta. Klik na labelu
    // nije uvijek dovoljan, zato klikamo tocku gdje je krug nacrtan.
    const freshRect = label.getBoundingClientRect();
    const clickX = Math.max(8, freshRect.left - 24);
    const clickY = freshRect.top + freshRect.height / 2;
    const target = document.elementFromPoint(clickX, clickY) || label;

    clickAt(target, clickX, clickY);
    await sleep(250);

    if (sectionControls("Isporuka", ["Stavke", "Dodatno"]).filter((field) => looksLikeDateField(field)).length < 2) {
      for (const offset of [-34, -14, -44]) {
        const fallbackX = Math.max(8, freshRect.left + offset);
        const fallbackTarget = document.elementFromPoint(fallbackX, clickY) || label;
        clickAt(fallbackTarget, fallbackX, clickY);
        await sleep(150);
      }
    }

    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(150);
    return true;
  }

  async function clickSecondDeliveryRadio(scope) {
    const radios = scope.querySelectorAll("input[type='radio'], [role='radio']")
      .sort(byScreenPosition);

    if (radios[1]) {
      const rect = radios[1].getBoundingClientRect();
      clickAt(radios[1], rect.left + rect.width / 2, rect.top + rect.height / 2);
      await sleep(250);
      return true;
    }

    const heading = findVisibleText(["Odaberi nacin isporuke", "Odaberi način isporuke"], scope);
    const headingBottom = heading ? heading.getBoundingClientRect().bottom : -Infinity;
    const labels = scope.querySelectorAll("span, div, label")
      .filter((element) => {
        const text = normalizeText(element.innerText || element.textContent || "");
        const rect = element.getBoundingClientRect();
        return text.includes("period isporuke") && rect.top > headingBottom;
      })
      .sort(byScreenPosition);

    const periodLabel = labels[0];
    if (!periodLabel) {
      return false;
    }

    const rect = periodLabel.getBoundingClientRect();
    const points = [
      [rect.left - 24, rect.top + rect.height / 2],
      [rect.left - 32, rect.top + rect.height / 2],
      [rect.left - 16, rect.top + rect.height / 2]
    ];

    for (const point of points) {
      const target = document.elementFromPoint(point[0], point[1]) || periodLabel;
      clickAt(target, point[0], point[1]);
      await sleep(150);
    }

    return true;
  }

  function clickAt(element, clientX, clientY) {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      const EventConstructor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      element.dispatchEvent(new EventConstructor(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: type.endsWith("down") ? 1 : 0
      }));
    }
  }

  async function chooseDateFromPicker(control, date) {
    const target = focusControl(control);
    const anchorRect = target.getBoundingClientRect();

    target.scrollIntoView({ block: "center", inline: "center" });
    target.focus();
    clickAt(target, anchorRect.right - 18, anchorRect.top + anchorRect.height / 2);
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
    await sleep(250);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const dayButton = findCalendarDay(date, anchorRect);

      if (dayButton) {
        const rect = dayButton.getBoundingClientRect();
        clickAt(dayButton, rect.left + rect.width / 2, rect.top + rect.height / 2);
        dayButton.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(250);
        return true;
      }

      if (!clickNextCalendarMonth()) {
        break;
      }

      await sleep(250);
    }

    return false;
  }

  function typeDateLikeUser(control, date) {
    const target = focusControl(control);
    const value = formatCroatianDate(date);

    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      return false;
    }

    target.focus();
    target.select();
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", bubbles: true }));

    const prototype = target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (setter) {
      setter.call(target, "");
    } else {
      target.value = "";
    }

    fireFormEvents(target, "");

    for (const character of value) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
      const nextValue = `${target.value || ""}${character}`;

      if (setter) {
        setter.call(target, nextValue);
      } else {
        target.value = nextValue;
      }

      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: character }));
      target.dispatchEvent(new KeyboardEvent("keyup", { key: character, bubbles: true }));
    }

    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    target.blur();
    target.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }

  function findCalendarDay(date, anchorRect) {
    const day = String(date.getDate());
    const year = String(date.getFullYear());
    const monthNames = [
      "sijecanj", "veljaca", "ozujak", "travanj", "svibanj", "lipanj",
      "srpanj", "kolovoz", "rujan", "listopad", "studeni", "prosinac"
    ];
    const month = monthNames[date.getMonth()];
    const candidates = documentScope()
      .querySelectorAll("button, [role='button'], [role='gridcell'], td, div, span")
      .filter((element) => {
        if (isSubmitLike(element)) {
          return false;
        }

        const rect = element.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
          return false;
        }

        if (rect.top < anchorRect.top - 80) {
          return false;
        }

        const text = normalizeText(element.innerText || element.textContent || "");
        const aria = normalizeText([
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("data-date")
        ].filter(Boolean).join(" "));

        const disabled = element.getAttribute("aria-disabled") === "true" || element.hasAttribute("disabled");
        if (disabled) {
          return false;
        }

        if ((element.getAttribute("role") === "gridcell" || element.tagName.toLowerCase() === "button") && text === day && (!aria || aria.includes(year) || aria.includes(month))) {
          return true;
        }

        return aria.includes(day) && aria.includes(year) && aria.includes(month);
      })
      .sort((a, b) => {
        const roleA = a.getAttribute("role") === "gridcell" ? 0 : 1;
        const roleB = b.getAttribute("role") === "gridcell" ? 0 : 1;
        return roleA - roleB || area(a) - area(b);
      });

    return candidates[0] || null;
  }

  function clickNextCalendarMonth() {
    const next = documentScope()
      .querySelectorAll("button, [role='button']")
      .find((element) => {
        const text = normalizeText([
          element.innerText,
          element.textContent,
          element.getAttribute("aria-label"),
          element.getAttribute("title")
        ].filter(Boolean).join(" "));

        return /next|sljedeci|sljedeći|naprijed|chevron-right|arrow-right/.test(text);
      });

    if (!next || isSubmitLike(next)) {
      return false;
    }

    const rect = next.getBoundingClientRect();
    clickAt(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
    return true;
  }

  function area(element) {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function sectionControls(startHeading, endHeadings) {
    return sectionScope(startHeading, endHeadings)
      .querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox'], [role='combobox'], [tabindex]")
      .filter(isUsableControl)
      .sort(byScreenPosition);
  }

  function controlByName(name) {
    return documentScope()
      .querySelectorAll("input, textarea, [role='textbox'], [role='combobox']")
      .find((field) => field.getAttribute("name") === name || field.getAttribute("id") === name);
  }

  function controlsByName(name) {
    const expected = normalizeText(name);

    return sectionControls("Stavke", ["Dodatno"])
      .filter((field) => fieldMatchesName(field, expected));
  }

  function itemControlsByName(index) {
    const fields = itemBlockControls(index);
    const named = {
      quantity: fields.find((field) => fieldMatchesName(field, "quantity")) || controlsByName("quantity")[index] || null,
      unit: fields.find((field) => fieldMatchesName(field, "unit")) || controlsByName("unit")[index] || null,
      unitPrice: fields.find((field) => fieldMatchesName(field, "unitprice")) || controlsByName("unitPrice")[index] || null,
      discountRate: fields.find((field) => fieldMatchesName(field, "discountrate")) || controlsByName("discountRate")[index] || null,
      taxPercentage: fields.find((field) => fieldMatchesName(field, "taxpercentage")) || controlsByName("taxPercentage")[index] || null
    };

    const quantityTop = named.quantity ? named.quantity.getBoundingClientRect().top : -Infinity;
    const quantityLeft = named.quantity ? named.quantity.getBoundingClientRect().left : Infinity;
    const nextQuantity = controlsByName("quantity")[index + 1];
    const nextTop = nextQuantity ? nextQuantity.getBoundingClientRect().top : Infinity;

    named.product = fields.find((field) => {
      const rect = field.getBoundingClientRect();
      const text = normalizeText(fieldText(field));
      return rect.top >= quantityTop - 40 &&
        rect.top < nextTop &&
        field.getAttribute("role") === "combobox" &&
        !fieldMatchesName(field, "unit") &&
        !fieldMatchesName(field, "taxpercentage") &&
        !fieldMatchesName(field, "taxexcludebasis") &&
        !text.includes("kpdmark") &&
        rect.left < quantityLeft;
    }) || null;

    return named;
  }

  function itemBlockControls(index) {
    const fields = sectionControls("Stavke", ["Dodatno"]);
    const quantities = fields.filter((field) => fieldMatchesName(field, "quantity"));
    const quantity = quantities[index];

    if (!quantity) {
      return [];
    }

    const top = quantity.getBoundingClientRect().top;
    const nextTop = quantities[index + 1]?.getBoundingClientRect().top ?? Infinity;

    return fields
      .filter((field) => {
        const rect = field.getBoundingClientRect();
        return rect.top >= top - 70 && rect.top < nextTop - 8;
      })
      .sort(byScreenPosition);
  }

  function fieldMatchesName(field, expectedName) {
    const expected = normalizeText(expectedName);
    const directValues = [
      field.getAttribute("name"),
      field.getAttribute("id"),
      field.getAttribute("aria-label"),
      field.getAttribute("placeholder")
    ].map(normalizeText);

    if (directValues.some((value) => value === expected)) {
      return true;
    }

    const text = normalizeText(fieldText(field));

    if (expected === "unit") {
      return wholeWord(text, "unit") && !wholeWord(text, "unitprice");
    }

    if (["quantity", "unitprice", "discountrate", "taxpercentage", "taxexcludebasis", "taxexcludereason"].includes(expected)) {
      return wholeWord(text, expected);
    }

    return text.includes(expected);
  }

  function wholeWord(text, word) {
    return new RegExp(`(^|[^a-z0-9])${escapeRegex(word)}([^a-z0-9]|$)`).test(text);
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function scrollToItemIndex(index) {
    const quantities = controlsByName("quantity");
    const anchor = quantities[index] || findHeading("Stavke");

    if (anchor) {
      anchor.scrollIntoView({ block: "center", inline: "center" });
    }
  }

  function itemField(labelCandidates, occurrenceIndex) {
    const labels = labelCandidates.map(normalizeText);
    const matches = sectionControls("Stavke", ["Dodatno"])
      .filter((field) => {
        const text = normalizeText(itemFieldText(field));

        if (labels.some((label) => label !== "pdv" && label !== "popust" && text.includes(label))) {
          return true;
        }

        if (labels.includes("pdv")) {
          return /\bpdv\b/.test(text) && !text.includes("razlog") && !text.includes("iznos");
        }

        if (labels.includes("popust")) {
          return text.includes("popust");
        }

        return false;
      })
      .filter((field) => {
        const text = normalizeText(itemFieldText(field));
        return !text.includes("kpd") && !text.includes("opis") && !text.includes("iznos s pdv") && !text.includes("osnovica");
      })
      .sort(byScreenPosition);

    return matches[occurrenceIndex] || null;
  }

  function itemFieldText(field) {
    const parts = [
      field.getAttribute("aria-label"),
      field.getAttribute("placeholder"),
      field.getAttribute("name"),
      field.getAttribute("id")
    ];

    let parent = field.closest("label, div");
    for (let depth = 0; parent && depth < 3; depth += 1) {
      const text = parent.innerText || parent.textContent || "";
      if (text.length < 260) {
        parts.push(text);
      }
      parent = parent.parentElement?.closest?.("label, div");
    }

    return parts.filter(Boolean).join(" ");
  }

  function itemControlsForIndex(index) {
    const controlsPerItem = 9;
    const fields = sectionControls("Stavke", ["Dodatno"]);
    return fields.slice(index * controlsPerItem, index * controlsPerItem + controlsPerItem);
  }

  async function waitForItemControls(minimumCount) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (sectionControls("Stavke", ["Dodatno"]).length >= minimumCount) {
        return true;
      }

      await sleep(250);
    }

    return false;
  }

  async function waitForItemIndex(index) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (controlsByName("quantity").length > index) {
        return true;
      }

      await sleep(250);
    }

    return false;
  }

  async function waitForTaxExemptionFields(index) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (findTaxExemptionControl(index) && findReasonControl(index)) {
        return true;
      }

      await sleep(250);
    }

    return false;
  }

  function findReasonControl(index) {
    const block = itemBlockControls(index);
    const byName = block.find((field) => fieldMatchesName(field, "taxexcludereason")) || controlsByName("taxExcludeReason")[index];
    if (byName) {
      return byName;
    }

    const scope = sectionScope("Stavke", ["Dodatno"]);
    const matches = scope.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox']")
      .filter(isUsableControl)
      .filter((field) => {
        const text = normalizeText(itemFieldText(field));
        return text.includes("razlog oslobodenja") || text.includes("pdv-a");
      })
      .sort(byScreenPosition);

    if (matches[index]) {
      return matches[index];
    }

    const taxField = controlsByName("taxPercentage")[index];
    if (!taxField) {
      return null;
    }

    const taxRect = taxField.getBoundingClientRect();
    const nextTax = controlsByName("taxPercentage")[index + 1];
    const nextTop = nextTax ? nextTax.getBoundingClientRect().top : Infinity;

    return scope.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox']")
      .filter(isUsableControl)
      .filter((field) => {
        const rect = field.getBoundingClientRect();
        const text = normalizeText(itemFieldText(field));
        return rect.top > taxRect.top + 20 &&
          rect.top < nextTop &&
          !text.includes("kpd") &&
          !text.includes("opis");
      })
      .sort(byScreenPosition)[0] || null;
  }

  function findTaxExemptionControl(index) {
    const block = itemBlockControls(index);
    const byName = block.find((field) => fieldMatchesName(field, "taxexcludebasis")) || controlsByName("taxExcludeBasis")[index];
    if (byName) {
      return byName;
    }

    const taxField = controlsByName("taxPercentage")[index];
    if (!taxField) {
      return itemField(["Osnova oslobodenja"], index);
    }

    const taxRect = taxField.getBoundingClientRect();
    const nextTax = controlsByName("taxPercentage")[index + 1];
    const nextTop = nextTax ? nextTax.getBoundingClientRect().top : Infinity;

    return sectionControls("Stavke", ["Dodatno"])
      .filter((field) => {
        const rect = field.getBoundingClientRect();
        const name = field.getAttribute("name") || "";
        return rect.top >= taxRect.top - 45 &&
          rect.top < nextTop &&
          rect.left > taxRect.left + 40 &&
          field.getAttribute("role") === "combobox" &&
          name !== "kpdMark";
      })
      .sort(byScreenPosition)[0] || itemField(["Osnova oslobodenja"], index);
  }

  function itemTitleForParra(item) {
    const title = String(item.name || "").trim();
    const variant = String(item.variant || "")
      .replace(/\s*STT[A-Z0-9-]+.*$/i, "")
      .replace(/\s*SKU.*$/i, "")
      .trim();

    if (!variant || title.includes(variant)) {
      return title;
    }

    return `${title} ${variant}`;
  }

  function itemRows() {
    const fields = sectionControls("Stavke", ["Dodatno"]);
    const rows = [];

    for (const field of fields) {
      const rect = field.getBoundingClientRect();
      let row = rows.find((candidate) => Math.abs(candidate.top - rect.top) < 55);

      if (!row) {
        row = { top: rect.top, fields: [] };
        rows.push(row);
      }

      row.fields.push(field);
    }

    return rows
      .map((row) => row.fields.sort(byScreenPosition))
      .filter((row) => row.length >= 4);
  }

  function findItemControlByText(label, occurrenceIndex) {
    const fields = sectionControls("Stavke", ["Dodatno"]);
    const matches = fields.filter((field) => normalizeText(fieldText(field)).includes(normalizeText(label)));
    return matches[occurrenceIndex] || null;
  }

  function sectionScope(startHeading, endHeadings) {
    const start = findHeading(startHeading);
    const startTop = start ? pageTop(start) : -Infinity;
    const endTop = endHeadings
      .map(findHeading)
      .filter(Boolean)
      .map(pageTop)
      .filter((top) => top > startTop + 10)
      .sort((a, b) => a - b)[0] || Infinity;

    return {
      querySelectorAll(selector) {
        return deepQuerySelectorAll(selector)
          .filter(isVisible)
          .filter((element) => {
            const top = pageTop(element);
            return top >= startTop && top < endTop;
          });
      }
    };
  }

  function documentScope() {
    return {
      querySelectorAll(selector) {
        return deepQuerySelectorAll(selector).filter(isVisible);
      }
    };
  }

  function findHeading(text) {
    const expected = normalizeText(text);

    return deepQuerySelectorAll("h1, h2, h3, h4, strong, b, p, span, div")
      .filter(isVisible)
      .find((element) => {
        const value = normalizeText(element.innerText || element.textContent || "");
        return value === expected || value.startsWith(`${expected} `);
      });
  }

  function findVisibleText(texts, scope, preferExact = false) {
    const labels = texts.map(normalizeText);
    const elements = scope.querySelectorAll("button, [role='button'], [role='option'], li, div, span, label")
      .filter((element) => {
        const text = normalizeText(element.innerText || element.textContent || "");
        return text.length > 0 && text.length < 100 && labels.some((label) => preferExact ? text === label : text.includes(label));
      });

    return elements.find((element) => element.getAttribute("role") === "option") || elements[0] || null;
  }

  function isUsableControl(element) {
    if (isSubmitLike(element)) {
      return false;
    }

    if (element instanceof HTMLInputElement) {
      return !["hidden", "submit", "button", "checkbox", "radio"].includes(element.type);
    }

    if (element.matches("[tabindex]")) {
      const child = element.querySelector("input, textarea, [contenteditable='true'], [role='textbox'], [role='combobox']");
      if (child) {
        return !isVisible(child);
      }
    }

    if (element.matches("[tabindex]") && !element.matches("[role='combobox'], [role='textbox'], [contenteditable='true']")) {
      return false;
    }

    return true;
  }

  function focusControl(control) {
    control.scrollIntoView({ block: "center", inline: "center" });
    control.focus();
    control.click();

    const active = document.activeElement;
    if (active && active !== document.body && active !== control && control.contains?.(active)) {
      return active;
    }

    return control.querySelector?.("input, textarea, [contenteditable='true'], [role='textbox']") || control;
  }

  function isSubmitLike(element) {
    const text = normalizeText(element?.innerText || element?.textContent || element?.value || "");
    const type = normalizeText(element?.getAttribute?.("type") || "");
    return type === "submit" || /izdaj racun|izradi racun|spremi nacrt|submit/.test(text);
  }

  function fireFormEvents(element, value) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function fieldText(field) {
    return [
      field.getAttribute("aria-label"),
      field.getAttribute("placeholder"),
      field.getAttribute("name"),
      field.getAttribute("id"),
      field.closest("div")?.innerText
    ].filter(Boolean).join(" ");
  }

  function readControl(control) {
    if (!control) {
      return "";
    }

    return control.value || control.getAttribute("value") || control.textContent || "";
  }

  function looksLikeDateField(field) {
    return /datum|\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/i.test(fieldText(field) + " " + readControl(field));
  }

  function pageTop(element) {
    return element.getBoundingClientRect().top + window.scrollY;
  }

  function byScreenPosition(a, b) {
    const rectA = a.getBoundingClientRect();
    const rectB = b.getBoundingClientRect();

    if (Math.abs(rectA.top - rectB.top) > 8) {
      return rectA.top - rectB.top;
    }

    return rectA.left - rectB.left;
  }

  function deepQuerySelectorAll(selector, root = document) {
    const results = Array.from(root.querySelectorAll(selector));

    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (element.shadowRoot) {
        results.push(...deepQuerySelectorAll(selector, element.shadowRoot));
      }
    }

    return results;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function makeDebugSummary() {
    const buyerCount = sectionControls("Podaci o kupcu", ["Osnovni podaci", "Isporuka", "Stavke"]).length;
    const basicsCount = sectionControls("Osnovni podaci", ["Isporuka", "Stavke", "Dodatno"]).length;
    const deliveryCount = sectionControls("Isporuka", ["Stavke", "Dodatno"]).length;
    const itemCount = sectionControls("Stavke", ["Dodatno"]).length;

    return `Debug: vidim polja po sekcijama kupac=${buyerCount}, osnovni=${basicsCount}, isporuka=${deliveryCount}, stavke=${itemCount}.`;
  }

  function makeFieldDebug(title, fields) {
    const parts = fields.slice(0, 12).map((field, index) => {
      const rect = field.getBoundingClientRect();
      const text = compactDebugText(fieldText(field) || readControl(field) || field.textContent || field.tagName);
      return `${index + 1}:${field.tagName.toLowerCase()} ${field.getAttribute("role") || ""} "${text}" @${Math.round(rect.left)},${Math.round(rect.top)}`;
    });

    return `${title}: ${parts.join(" | ")}`;
  }

  function compactDebugText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 70);
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeNumber(value) {
    const number = String(value || "1").match(/\d+/)?.[0] || "1";
    return number.replace(".", ",");
  }

  function normalizeQuantity(value) {
    const number = String(value || "1").match(/\d+/)?.[0] || "1";
    return `${number},00`;
  }

  function moneyToDecimal(value) {
    const match = String(value || "").match(/-?\d+[.,]\d{2}/);
    return match ? match[0].replace(".", ",") : "";
  }

  function discountToPercent(value) {
    if (!value) {
      return "0";
    }

    const percent = String(value).match(/\d+[.,]?\d*\s*%/);
    return percent ? percent[0].replace("%", "").trim() : "0";
  }

  function discountPercentForItem(item, order) {
    if (item.isShipping) return "0";
    if (/WELCOME10/i.test(order.discountCode || "")) {
      return "10,00";
    }

    const directPercent = String(item.discount || "").match(/\d+[.,]?\d*\s*%/);
    if (directPercent) {
      return directPercent[0].replace("%", "").trim();
    }

    const discount = moneyToNumber(item.discount || order.discount);
    const unitPrice = moneyToNumber(item.unitPrice);
    const quantity = Number(String(item.quantity || "1").match(/\d+/)?.[0] || "1");
    const base = unitPrice * quantity;

    if (!discount || !base) {
      return "0";
    }

    return String(Math.round((Math.abs(discount) / base) * 10000) / 100).replace(".", ",");
  }

  function moneyToNumber(value) {
    const match = String(value || "").match(/-?\d+[.,]\d{2}/);
    return match ? Number(match[0].replace(",", ".")) : 0;
  }

  function normalizeCountry(value) {
    return /croatia|hrvatska/i.test(String(value || "")) ? "Hrvatska" : value || "Hrvatska";
  }

  function joinPostalCity(address) {
    return [address.postalCode, address.city].filter(Boolean).join(" ") || address.city || "";
  }

  function parseCroatianDate(value) {
    const match = String(value || "").match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
    return match ? new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])) : null;
  }

  function formatCroatianDate(date) {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}.${date.getFullYear()}.`;
  }

  function addBusinessDays(date, days) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    let added = 0;

    while (added < days) {
      result.setDate(result.getDate() + 1);
      if (result.getDay() !== 0 && result.getDay() !== 6) {
        added += 1;
      }
    }

    return result;
  }

  function invoiceItems(order) {
    const items = uniqueItems(Array.isArray(order.items) ? order.items : []);
    const cost = moneyToNumber(order.shippingCost);
    if (cost > 0) {
      items.push({ name: "Dostava", quantity: "1", unitPrice: cost.toFixed(2), isShipping: true });
    }
    return items;
  }

  function uniqueItems(items) {
    const seen = new Set();

    return items.filter((item) => {
      const key = normalizeText(`${item.name}|${item.variant}|${item.quantity}|${item.unitPrice}`);

      if (!item.name || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
