/**
 * Common types and enums
 */

export type PositionSide = "supply" | "borrow";

/**
 * Supported lending protocols
 */
export enum LendingProtocol {
  Suilend = "suilend",
  Navi = "navi",
  Scallop = "scallop",
}
