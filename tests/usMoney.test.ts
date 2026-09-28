import { moneyToWords } from '../src/utils/numberToWords';
test('USD uses cents and western numbering', () => {
  expect(moneyToWords(1100.05, 'USD')).toBe('One Thousand One Hundred Dollars and 05/100');
  expect(moneyToWords(100000, 'USD')).toBe('One Hundred Thousand Dollars and 00/100');
  expect(moneyToWords(1.999, 'USD')).toBe('Two Dollars and 00/100');
});
test('legacy INR amount wording is preserved', () => {
  expect(moneyToWords(10.5, 'INR')).toBe('Ten Rupees and Fifty Paise Only');
});
