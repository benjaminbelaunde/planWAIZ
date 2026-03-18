const DEFAULT_TIMEZONE = "America/Los_Angeles";

function resolveTimeZone(timeZone) {
  return String(timeZone || DEFAULT_TIMEZONE);
}

function resolveNow(nowOverride) {
  if (typeof nowOverride === "function") {
    return new Date(nowOverride());
  }
  if (nowOverride) {
    return new Date(nowOverride);
  }
  return new Date();
}

function getTimeZoneParts(value, timeZone = DEFAULT_TIMEZONE) {
  const date = new Date(value);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  parts.forEach((part) => {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  });
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function getTimeZoneOffsetMs(value, timeZone = DEFAULT_TIMEZONE) {
  const parts = getTimeZoneParts(value, timeZone);
  const utcEquivalent = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return utcEquivalent - new Date(value).getTime();
}

function zonedDateTimeToUtc(parts, timeZone = DEFAULT_TIMEZONE) {
  let guess = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour || 0),
    Number(parts.minute || 0),
    Number(parts.second || 0),
    0
  );

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = getTimeZoneOffsetMs(guess, timeZone);
    const candidate = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour || 0),
      Number(parts.minute || 0),
      Number(parts.second || 0),
      0
    ) - offset;
    if (candidate === guess) {
      break;
    }
    guess = candidate;
  }

  return new Date(guess);
}

function startOfDayInTimeZone(value, timeZone = DEFAULT_TIMEZONE) {
  const parts = getTimeZoneParts(value, timeZone);
  return zonedDateTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0
  }, timeZone);
}

function addDaysInTimeZone(value, days, timeZone = DEFAULT_TIMEZONE) {
  const parts = getTimeZoneParts(value, timeZone);
  return zonedDateTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day + Number(days || 0),
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  }, timeZone);
}

function combineDateAndTimeInTimeZone(dateLike, hhmm, timeZone = DEFAULT_TIMEZONE) {
  const parts = getTimeZoneParts(dateLike, timeZone);
  const [hours, minutes] = String(hhmm || "00:00").split(":").map((value) => Number(value));
  return zonedDateTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: Number.isFinite(hours) ? hours : 0,
    minute: Number.isFinite(minutes) ? minutes : 0,
    second: 0
  }, timeZone);
}

function nextWeekdayInTimeZone(value, weekdayName, forceNextWeek, timeZone = DEFAULT_TIMEZONE) {
  const parts = getTimeZoneParts(value, timeZone);
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const currentWeekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const targetWeekday = weekdays.indexOf(String(weekdayName || "").toLowerCase());
  let offset = (targetWeekday - currentWeekday + 7) % 7;
  if (offset === 0 || forceNextWeek) {
    offset += 7;
  }
  return zonedDateTimeToUtc({
    year: parts.year,
    month: parts.month,
    day: parts.day + offset,
    hour: 0,
    minute: 0,
    second: 0
  }, timeZone);
}

function toTimeZoneDateKey(value, timeZone = DEFAULT_TIMEZONE) {
  const parts = getTimeZoneParts(value, timeZone);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");
}

function formatInTimeZone(value, options, timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timeZone),
    ...options
  }).format(new Date(value));
}

module.exports = {
  DEFAULT_TIMEZONE,
  addDaysInTimeZone,
  combineDateAndTimeInTimeZone,
  formatInTimeZone,
  getTimeZoneParts,
  nextWeekdayInTimeZone,
  resolveNow,
  resolveTimeZone,
  startOfDayInTimeZone,
  toTimeZoneDateKey,
  zonedDateTimeToUtc
};
