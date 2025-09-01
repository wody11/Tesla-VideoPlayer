export type Sample = {
  kind: 'video'|'audio';
  tsUs: number;
  durUs: number;
  key: boolean;
  data: ArrayBuffer;
};
