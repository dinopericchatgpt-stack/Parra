// Popup ne cita stranice sam. On samo salje poruku content skripti
// koja je vec ucitana na Shopify ili Parra kartici.
const saveButton = document.getElementById("saveShopify");
const fillButton = document.getElementById("fillParra");
const statusBox = document.getElementById("status");
const extensionVersion = chrome.runtime.getManifest().version;
document.querySelector("h1").textContent = `Shopify Parra ${extensionVersion}`;

function setStatus(message, type) {
  statusBox.textContent = message;
  statusBox.className = "status";

  if (type) {
    statusBox.classList.add(type);
  }
}

function setBusy(isBusy) {
  saveButton.disabled = isBusy;
  fillButton.disabled = isBusy;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function sendActionToActiveTab(action) {
  const tab = await getActiveTab();

  if (!tab || !tab.id) {
    throw new Error("Ne mogu pronaci aktivnu karticu.");
  }

  if (action === "FILL_PARRA_FORM") {
    let info;
    try {
      info = await chrome.tabs.sendMessage(tab.id, { action: "GET_PARRA_VERSION" });
    } catch {
      throw new Error("Parra skripta nije azurirana ili nije ucitana. Osvjezi Parra karticu nakon azuriranja ekstenzije.");
    }
    if (info?.parraVersion !== extensionVersion) {
      throw new Error(`Verzija Parra skripte (${info?.parraVersion || "stara/nepoznata"}) ne odgovara ekstenziji (${extensionVersion}). Osvjezi Parra karticu.`);
    }
  }
  return chrome.tabs.sendMessage(tab.id, { action });
}

saveButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Citam podatke s otvorene Shopify narudzbe...", "");

  try {
    const response = await sendActionToActiveTab("SAVE_SHOPIFY_ORDER");

    if (!response || !response.ok) {
      throw new Error(response?.message || "Shopify skripta nije vratila uspjeh.");
    }

    const warningText = response.warnings?.length
      ? ` Upozorenja: ${response.warnings.join("; ")}`
      : "";

    const itemCount = response.order?.items?.length || 0;
    setStatus(`Narudzba je spremljena u chrome.storage.local. Stavki: ${itemCount}. Skripta: ${response.readerVersion || "stara verzija — osvjezi Shopify karticu"}.${warningText}`, response.warnings?.length ? "warning" : "success");
  } catch (error) {
    setStatus(`Greska: ${formatMessageError(error)}`, "error");
  } finally {
    setBusy(false);
  }
});

fillButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Popunjavam Parra formu iz spremljene narudzbe...", "");

  try {
    const response = await sendActionToActiveTab("FILL_PARRA_FORM");

    if (!response || !response.ok) {
      throw new Error(response?.message || "Parra skripta nije vratila uspjeh.");
    }

    const warningText = response.warnings?.length
      ? ` Upozorenja: ${response.warnings.join("; ")}`
      : "";

    setStatus(`Parra forma je popunjena. Racun nije izdan niti spremljen. Parra skripta: ${response.parraVersion || "nepoznata"}.${warningText}`, response.warnings?.length ? "warning" : "success");
  } catch (error) {
    setStatus(`Greska: ${formatMessageError(error)}`, "error");
  } finally {
    setBusy(false);
  }
});

function formatMessageError(error) {
  const message = error?.message || String(error);

  if (message.includes("Receiving end does not exist")) {
    return "Skripta nije ucitana na ovoj kartici. Reloadaj Shopify/Parra stranicu nakon reloada ekstenzije pa pokusaj opet.";
  }

  return message;
}
