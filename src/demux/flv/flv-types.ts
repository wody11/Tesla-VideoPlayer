/*
 * FLV constants modeled after Jessibuca's FLV loader split.
 */

export enum FlvTagType {
  Audio = 8,
  Video = 9,
  Script = 18
}

export enum FlvVideoCodecId {
  AVC = 7,
  HEVC = 12
}

export enum FlvAudioCodecId {
  G711A = 7,
  G711U = 8,
  AAC = 10
}

