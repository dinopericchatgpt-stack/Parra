(function () {
  // Ova skripta se ucita na Shopify order stranici, ali nista ne radi
  // dok popup ne posalje poruku SAVE_SHOPIFY_ORDER.

  const STORAGE_KEY = "latestOrder";

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== "SAVE_SHOPIFY_ORDER") {
      return false;
    }

    saveCurrentOrder()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, message: error.message }));

    // true kaze Chromeu da sendResponse dolazi asinkrono.
    return true;
  });

  async function saveCurrentOrder() {
    const warnings = [];
    const order = readOrderFromPage(warnings);

    await chrome.storage.local.set({ [STORAGE_KEY]: order });

    return {
      ok: true,
      order,
      warnings
    };
  }

  function readOrderFromPage(warnings) {
    const pageText = getCleanText(document.body);
    const pageLines = getPageLines(pageText);
    const customerBlock = findBlockByHeading(["Customer", "Kupac"]);
    const shippingBlock = extractAddressBlock(pageLines, "Shipping address");
    const rawBillingBlock = extractAddressBlock(pageLines, "Billing address");
    const billingBlock = /same as shipping address/i.test(rawBillingBlock) ? shippingBlock : rawBillingBlock;
    const paymentBlock = findBlockByHeading(["Paid", "Payment", "Placeno", "Plaćeno"]);
    const shippingAddress = readAddressBlock(shippingBlock, warnings, "shipping adresa");
    const billingAddress = readAddressBlock(billingBlock, warnings, "billing adresa");

    const order = {
      savedAt: new Date().toISOString(),
      sourceUrl: location.href,
      orderNumber: firstMatch(pageText, /#\s*\d+/) || firstMatch(document.title, /#\s*\d+/),
      customerName: billingAddress.name || shippingAddress.name || readCustomerName(customerBlock, pageText),
      companyName: readCompanyName(pageText),
      oib: firstMatch(pageText, /\b(?:OIB|VAT ID|VAT)\s*[:#]?\s*([A-Z0-9-]{8,15})\b/i, 1),
      email: firstMatch(pageText, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i),
      phone: readPhone(billingBlock) || readPhone(shippingBlock) || readPhone(customerBlock || pageText),
      billingAddress,
      shippingAddress,
      items: readItems(warnings),
      discount: readMoneyNearLabel(pageText, ["Discount", "Popust"]),
      discountCode: readDiscountCode(pageText),
      shippingCost: readShippingCost(pageText),
      paymentMethod: readPaymentMethod(paymentBlock || pageText),
      totals: {
        subtotal: readMoneyNearLabel(pageText, ["Subtotal", "Meduzbroj"]),
        total: readMoneyNearLabel(pageText, ["Total", "Ukupno"])
      }
    };

    requireValue(order.orderNumber, "broj narudzbe", warnings);
    requireValue(order.customerName, "ime i prezime kupca", warnings);
    requireValue(order.email, "email", warnings);
    if (!order.phone) {
      order.phone = order.billingAddress.phone || order.shippingAddress.phone || "";
    }

    requireValue(order.shippingAddress.full, "shipping adresa", warnings);

    if (!order.items.length) {
      warnings.push("Nisam uspio pouzdano procitati stavke.");
    }

    return order;
  }

  function getCleanText(element) {
    if (!element) {
      return "";
    }

    return (element.innerText || element.textContent || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getPageLines(text) {
    return String(text || "")
      .split("\n")
      .map(cleanValue)
      .filter(Boolean);
  }

  function extractAddressBlock(lines, heading) {
    const startIndex = lines.findIndex((line) => normalizeForSearch(line) === normalizeForSearch(heading));

    if (startIndex === -1) {
      return "";
    }

    const stopPattern = /^(billing address|shipping address|conversion summary|timeline|notes|additional details|customer|contact information|marketing|tags)$/i;
    const result = [];

    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];

      if (stopPattern.test(line)) {
        break;
      }

      if (/^view map$/i.test(line)) {
        continue;
      }

      result.push(line);
    }

    return result.join("\n");
  }

  function normalizeForSearch(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function firstMatch(text, regex, groupIndex = 0) {
    const match = (text || "").match(regex);
    return match ? cleanValue(match[groupIndex]) : "";
  }

  function cleanValue(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function requireValue(value, label, warnings) {
    if (!value) {
      warnings.push(`Nedostaje ${label}.`);
    }
  }

  function findBlockByHeading(headings) {
    const elements = Array.from(document.querySelectorAll("section, aside, article, div, li"));

    return elements
      .map((element) => ({ element, text: getCleanText(element) }))
      .filter((entry) => entry.text.length > 0 && entry.text.length < 2500)
      .find((entry) => headings.some((heading) => new RegExp(`(^|\\n)${escapeRegex(heading)}(\\n|$)`, "i").test(entry.text)))
      ?.text || "";
  }

  function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function readCustomerName(customerBlock, pageText) {
    if (customerBlock) {
      const lines = customerBlock.split("\n").map(cleanValue).filter(Boolean);
      const customerHeadingIndex = lines.findIndex((line) => /^customer|^kupac/i.test(line));
      const possibleName = lines
        .slice(customerHeadingIndex + 1)
        .find((line) => !isBadCustomerLine(line) && !/orders?|narudz/i.test(line) && !/@/.test(line) && !/address|adresa|contact/i.test(line));

      if (possibleName) {
        return possibleName;
      }
    }

    return firstMatch(pageText, /Customer\s*\n\s*([^\n]+)/i, 1);
  }

  function isBadCustomerLine(line) {
    return /additional details|notes|conversion summary|customer|contact information|shipping address|billing address|view map|search/i.test(line);
  }

  function readCompanyName(pageText) {
    return firstMatch(pageText, /\b(?:Company|Firma|Naziv firme)\s*[:#]?\s*([^\n]+)/i, 1);
  }

  function readPhone(text) {
    return firstMatch(text, /(?:\+?\d[\d\s().-]{6,}\d)/);
  }

  function readAddressBlock(block, warnings, label) {
    const address = {
      full: "",
      name: "",
      company: "",
      street: "",
      extra: "",
      postalCode: "",
      city: "",
      country: "",
      phone: ""
    };

    if (!block) {
      warnings.push(`Nisam pronasao blok za ${label}.`);
      return address;
    }

    const lines = block
      .split("\n")
      .map(cleanValue)
      .filter(Boolean)
      .filter((line) => !/^(shipping address|billing address|adresa dostave|adresa za naplatu|view map|same as shipping address|same as billing address)$/i.test(line));

    address.full = lines.join("\n");
    address.name = lines[0] || "";
    address.phone = readPhone(block);
    address.country = lines.find((line) => /croatia|hrvatska/i.test(line)) || "";

    const postalLine = lines.find((line) => /\b\d{5}\b/.test(line));
    if (postalLine) {
      address.postalCode = firstMatch(postalLine, /\b(\d{5})\b/, 1);
      address.city = cleanValue(postalLine.replace(address.postalCode, ""));
    }

    if (!address.city) {
      const cityLine = lines.find((line) => !line.includes("@") && !readPhone(line) && !/croatia|hrvatska/i.test(line) && line !== address.name && line !== address.street);
      address.city = cityLine || "";
    }

    const streetLine = lines.find((line) => !line.includes("@") && !readPhone(line) && !/\b\d{5}\b/.test(line) && !/croatia|hrvatska/i.test(line) && line !== address.name);
    address.street = streetLine && !/search|additional details|notes/i.test(streetLine) ? streetLine : "";

    return address;
  }

  function readMoneyNearLabel(text, labels) {
    for (const label of labels) {
      const regex = new RegExp(`${escapeRegex(label)}[^\\n€$-]*(?:-|Free shipping|Besplatno)?[^\\n]*(€\\s*-?\\d+[\\d.,]*|-?\\d+[\\d.,]*\\s*€|0[,.]00)`, "i");
      const value = firstMatch(text, regex, 1);

      if (value) {
        return value;
      }
    }

    return "";
  }

  function readShippingCost(text) {
    const lines = getPageLines(text);
    const money = /(?:€|EUR)\s*(\d+(?:[.,]\d{2}))|(\d+(?:[.,]\d{2}))\s*(?:€|EUR)/i;
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^(shipping|dostava)(?:$|\s|:)/i.test(lines[i]) || /^(shipping address|shipping method)/i.test(lines[i])) continue;
      for (let j = i; j < Math.min(lines.length, i + 4); j += 1) {
        if (j > i && /^(total|subtotal|tax|paid|discount|ukupno|porez|popust|customer|billing|shipping address)\b/i.test(lines[j])) break;
        if (/free|besplatno/i.test(lines[j])) return "0.00";
        const match = lines[j].match(money);
        if (match) return match[1] || match[2];
      }
    }
    return "";
  }

  function readPaymentMethod(text) {
    const lines = String(text || "")
      .split("\n")
      .map(cleanValue)
      .filter(Boolean);

    return lines.find((line) => /card|visa|mastercard|paypal|cod|cash|bank|transakcijski|placanje|plaćanje/i.test(line)) || "";
  }

  function readItems(warnings) {
    const lineItems = readItemsFromPageLines(getPageLines(getCleanText(document.body)));

    if (lineItems.length) {
      return dedupeItems(lineItems);
    }

    const candidates = Array.from(document.querySelectorAll("tr, [role='row'], li, div"))
      .map((element) => ({ element, text: getCleanText(element) }))
      .filter((entry) => isPossibleItemRow(entry.text));

    const items = [];
    const seen = new Set();

    const topToBottom = candidates.sort((a, b) => {
      const rectA = a.element.getBoundingClientRect();
      const rectB = b.element.getBoundingClientRect();

      if (Math.abs(rectA.top - rectB.top) > 4) {
        return rectA.top - rectB.top;
      }

      return rectA.left - rectB.left;
    });

    for (const candidate of topToBottom) {
      const item = parseItemText(candidate.text);
      const key = `${item.name}|${item.variant}|${item.unitPrice}|${item.quantity}`;

      if (item.name && item.unitPrice && !seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
    }

    const productLikeItems = items.filter((item) => /\/|STT|SKU/i.test(item.variant));
    if (productLikeItems.length) {
      return dedupeItems(productLikeItems);
    }

    if (items.length > 20) {
      warnings.push("Procitano je neobicno puno stavki; provjeri spremljeni JSON.");
      return dedupeItems(items).slice(0, 20);
    }

    return dedupeItems(items);
  }

  function dedupeItems(items) {
    const seen = new Set();

    return items.filter((item) => {
      const key = normalizeForSearch(`${item.name}|${cleanVariantLine(item.variant)}|${moneyToPlain(item.unitPrice)}|${item.quantity || "1"}`);

      if (!item.name || !item.variant || !item.unitPrice || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  function moneyToPlain(value) {
    return String(value || "")
      .replace(/[^\d,.-]/g, "")
      .replace(".", ",");
  }

  function readItemsFromPageLines(lines) {
    const items = [];
    const seen = new Set();

    for (let index = 0; index < lines.length; index += 1) {
      const variantLine = lines[index];

      if (!isVariantLine(variantLine)) {
        continue;
      }

      const name = findProductNameBefore(lines, index);
      const unitPrice = findMoneyAfter(lines, index);
      const variant = cleanVariantLine(variantLine);

      if (!name || !variant || !unitPrice) {
        continue;
      }

      const quantity = findQuantityAfter(lines, index) || "1";
      const key = normalizeForSearch(`${name}|${variant}|${unitPrice}|${quantity}`);

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      items.push({
        name,
        variant,
        quantity,
        unitPrice,
        discount: "",
        totalPrice: unitPrice
      });
    }

    return items;
  }

  function isVariantLine(line) {
    return /\/|STT|SKU/i.test(line) &&
      !/subtotal|shipping|total|paid|refund|discount|dostava|ukupno|meduzbroj/i.test(line);
  }

  function cleanVariantLine(line) {
    return cleanValue(line)
      .replace(/\s*STT[A-Z0-9-]+.*$/i, "")
      .replace(/\s*SKU.*$/i, "")
      .trim();
  }

  function findProductNameBefore(lines, variantIndex) {
    for (let index = variantIndex - 1; index >= Math.max(0, variantIndex - 5); index -= 1) {
      if (isProductNameLine(lines[index])) {
        return lines[index];
      }
    }

    return "";
  }

  function findMoneyAfter(lines, startIndex) {
    for (let index = startIndex + 1; index <= Math.min(lines.length - 1, startIndex + 8); index += 1) {
      const value = firstMatch(lines[index], /(?:€|EUR)\s*-?\d+[.,]\d{2}|-?\d+[.,]\d{2}\s*(?:€|EUR)/i);

      if (value) {
        return value;
      }
    }

    return "";
  }

  function findQuantityAfter(lines, startIndex) {
    for (let index = startIndex + 1; index <= Math.min(lines.length - 1, startIndex + 8); index += 1) {
      const sameLine = firstMatch(lines[index], /(?:x|×)\s*(\d+)/i, 1);

      if (sameLine) {
        return sameLine;
      }

      if (/^(x|×)$/i.test(lines[index]) && /^\d+$/.test(lines[index + 1] || "")) {
        return lines[index + 1];
      }
    }

    return "";
  }

  function isPossibleItemRow(text) {
    if (!text || text.length > 260) {
      return false;
    }

    const moneyValues = text.match(/(?:€|EUR)\s*-?\d+[.,]\d{2}|-?\d+[.,]\d{2}\s*(?:€|EUR)/g) || [];
    if (!moneyValues.length || moneyValues.length > 3) {
      return false;
    }

    if (/subtotal|shipping|total|paid|refund|dostava|ukupno|meduzbroj/i.test(text)) {
      return false;
    }

    // Shopify stavka u ovom shopu ima varijantu/SKU red, npr. "White / XL STTU169C001X".
    // Ovo sprjecava da mali tekstovi poput "x" ili labela "Unit price" postanu stavka.
    return /\/|STT|SKU/i.test(text) && /(?:x|×)\s*\d+|\bQty\s*\d+\b/i.test(text);
  }

  function parseItemText(text) {
    const lines = text.split("\n").map(cleanValue).filter(Boolean);
    const moneyValues = text.match(/(?:€|EUR)\s*-?\d+[.,]\d{2}|-?\d+[.,]\d{2}\s*(?:€|EUR)/g) || [];
    const quantity = firstMatch(text, /(?:x|×)\s*(\d+)/i, 1) || firstMatch(text, /\bQty\s*(\d+)\b/i, 1) || "1";
    const variantIndex = lines.findIndex((line) => /\/|STT|SKU/i.test(line));
    const variant = variantIndex >= 0 ? lines[variantIndex] : "";
    const beforeVariant = variantIndex >= 0 ? lines.slice(0, variantIndex).reverse() : [];
    const name = beforeVariant.find(isProductNameLine) || lines.find(isProductNameLine) || "";

    return {
      name,
      variant,
      quantity,
      unitPrice: moneyValues[0] || "",
      discount: firstMatch(text, /discount\s*(-?€?\s*\d+[.,]\d{2})/i, 1),
      totalPrice: moneyValues[moneyValues.length - 1] || moneyValues[0] || ""
    };
  }

  function isProductNameLine(line) {
    return !/^(x|×)$/i.test(line) &&
      !/unit price|jedinicna cijena|jedinična cijena|quantity|kolicina|količina|total|subtotal|shipping|discount|paid|fulfillment|warehouse|free shipping|general profile/i.test(line) &&
      !/€|(?:x|×)\s*\d+|STT|SKU|^\d+$/.test(line);
  }

  function readDiscountCode(text) {
    const lines = getPageLines(text);
    const discountIndex = lines.findIndex((line) => /^discount$/i.test(line));

    if (discountIndex === -1) {
      return "";
    }

    return lines.slice(discountIndex + 1, discountIndex + 4)
      .find((line) => /^[A-Z0-9_-]{3,}$/.test(line) && !/€|\d+[,.]\d{2}/.test(line)) || "";
  }
})();
