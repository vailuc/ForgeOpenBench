import type { FilterKey } from "./types";

export interface FilterDef {
  key: FilterKey;
  label: string;
  css: string;
  ffmpegChain: string;
}

export const FILTER_DEFS: FilterDef[] = [
  {
    key: "orig",
    label: "Original",
    css: "none",
    ffmpegChain: "format=yuvj420p",
  },
  {
    key: "edge",
    label: "Edge",
    css: "contrast(300%) brightness(50%) grayscale(100%)",
    ffmpegChain: "edgedetect=mode=colormix:high=0,format=yuvj420p",
  },
  {
    key: "inv",
    label: "Invert",
    css: "invert(100%)",
    ffmpegChain: "negate,format=yuvj420p",
  },
  {
    key: "bw",
    label: "B&W",
    css: "grayscale(100%)",
    ffmpegChain: "hue=s=0,format=yuvj420p",
  },
  {
    key: "sharp",
    label: "Sharp",
    css: "contrast(130%) saturate(120%)",
    ffmpegChain: "unsharp=5:5:1.5:5:5:0,format=yuvj420p",
  },
];

export const FILTER_MAP: Record<FilterKey, FilterDef> = Object.fromEntries(
  FILTER_DEFS.map((f) => [f.key, f])
) as Record<FilterKey, FilterDef>;
