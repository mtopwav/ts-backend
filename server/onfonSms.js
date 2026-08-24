function isOnfonConfigured() {
  return Boolean(
    process.env.ONFON_ACCESS_KEY &&
      process.env.ONFON_API_KEY &&
      process.env.ONFON_CLIENT_ID &&
      process.env.ONFON_SENDER_ID
  );
}

function isOnfonBalanceConfigured() {
  return isOnfonConfigured();
}

async function getOnfonBalance() {
  if (!isOnfonBalanceConfigured()) {
    return { success: false, configured: false, error: "Onfon SMS is not configured" };
  }

  return { success: false, configured: true, error: "Balance API not configured" };
}

async function sendBulkMessages() {
  return {
    success: false,
    errorDescription: "Onfon SMS is not configured on the server"
  };
}

function normalizePhoneForOnfon(phone) {
  if (!phone) return null;

  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("255") && digits.length === 12) return digits;
  if (digits.length === 9) return `255${digits}`;
  return digits.length >= 9 ? digits : null;
}

function formatUnitsDisplay(units, credits) {
  if (units != null && !Number.isNaN(Number(units))) {
    return `${units} SMS`;
  }
  if (credits) return String(credits);
  return null;
}

module.exports = {
  isOnfonConfigured,
  isOnfonBalanceConfigured,
  getOnfonBalance,
  sendBulkMessages,
  normalizePhoneForOnfon,
  formatUnitsDisplay
};
