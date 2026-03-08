/**
 * Форматирует ROI для отображения
 */
export function formatRoi(roi: number, asPercentage: boolean = false): string {
  if (asPercentage) {
    return `${(roi * 100).toFixed(2)}%`;
  }
  return `${roi.toFixed(2)}x`;
}

/**
 * Форматирует число как валюту
 */
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
