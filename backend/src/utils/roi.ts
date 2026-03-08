/**
 * Утилиты для расчета ROI (Return on Investment)
 * ROI = (1 / цена) - 1
 * 
 * Примеры:
 * - Цена 0.15 → ROI = (1/0.15) - 1 = 5.67x (567%)
 * - Цена 0.20 → ROI = (1/0.20) - 1 = 4x (400%)
 * - Цена 0.50 → ROI = (1/0.50) - 1 = 1x (100%)
 */

/**
 * Рассчитывает потенциальный ROI для ставки
 * @param price Цена контракта (0-1)
 * @returns ROI в виде множителя (например, 5.67 для 567%)
 */
export function calculatePotentialRoi(price: number): number {
  if (price <= 0 || price >= 1) {
    throw new Error('Price must be between 0 and 1');
  }
  return (1 / price) - 1;
}

/**
 * Рассчитывает фактический ROI после закрытия ставки
 * @param entryPrice Цена входа
 * @param exitPrice Цена выхода (1.0 для выигрыша, 0.0 для проигрыша)
 * @returns ROI в виде множителя
 */
export function calculateActualRoi(entryPrice: number, exitPrice: number): number {
  if (entryPrice <= 0 || entryPrice >= 1) {
    throw new Error('Entry price must be between 0 and 1');
  }
  if (exitPrice < 0 || exitPrice > 1) {
    throw new Error('Exit price must be between 0 and 1');
  }
  
  // Если проиграли, ROI = -1 (потеряли 100%)
  if (exitPrice === 0) {
    return -1;
  }
  
  // Если выиграли, ROI = (1 / entryPrice) - 1
  return (exitPrice / entryPrice) - 1;
}

/**
 * Проверяет, является ли ROI асимметричным (>= 5x)
 * @param roi ROI в виде множителя
 * @returns true если ROI >= 5x (500%+)
 */
export function isAsymmetricRoi(roi: number): boolean {
  return roi >= 5;
}

/**
 * Форматирует ROI для отображения
 * @param roi ROI в виде множителя
 * @returns Отформатированная строка (например, "5.67x" или "567%")
 */
export function formatRoi(roi: number, asPercentage: boolean = false): string {
  if (asPercentage) {
    return `${(roi * 100).toFixed(2)}%`;
  }
  return `${roi.toFixed(2)}x`;
}
