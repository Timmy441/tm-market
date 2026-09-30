// Normalises Nigerian mobile numbers to E.164 (+234XXXXXXXXXX) so that
// 08012345678, +2348012345678, 2348012345678, 0801 234 5678 and
// 8012345678 are all recognised as the SAME number.
// Returns null when the input is not a valid Nigerian mobile number.
function normalizeNigerianPhone(input) {
  if (typeof input !== 'string') return null;

  let s = input.trim().replace(/[\s\-().]/g, '');

  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('00')) s = s.slice(2);

  if (!/^\d+$/.test(s)) return null;

  let national;
  if (s.startsWith('234')) {
    national = s.slice(3);
    if (national.startsWith('0')) national = national.slice(1); // +234 0801...
  } else if (s.startsWith('0')) {
    national = s.slice(1);
  } else {
    national = s;
  }

  // Nigerian mobile numbers: 10 digits after the country code, starting 7, 8 or 9.
  if (!/^[789]\d{9}$/.test(national)) return null;

  return `+234${national}`;
}

module.exports = { normalizeNigerianPhone };
