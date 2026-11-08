export function parseEuropeanDate(value) {
  if (!value) return "";
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (!match) return null;
  const [, day, month, year] = match;
  const isoDate = `${year}-${month}-${day}`;
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (
    year === "0000" ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== isoDate
  )
    return null;
  return isoDate;
}

export function formatEuropeanDate(value) {
  if (!value) return "";
  return value.split("-").reverse().join(".");
}

export function isValidTime(value) {
  return value === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
