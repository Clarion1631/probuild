"use client";

// Room Studio - builder registry. Maps CatalogItem.mesh -> procedural recipe.

import type { ComponentType } from "react";
import * as K from "./builders-kitchen";
import * as L from "./builders-living";

export interface BuilderProps {
  /** Resolved dimensions (item overrides applied), meters. */
  w: number;
  d: number;
  h: number;
  /** Resolved finish ids per slot (item overrides over catalog defaults). */
  finishes: Record<string, string | undefined>;
  /** Global lights toggle (bulb emissives + flame). */
  lightsOn?: boolean;
}

export const BUILDERS: Record<string, ComponentType<BuilderProps>> = {
  // cabinets
  "cabinet-base": K.CabinetBase,
  "cabinet-drawers": K.CabinetDrawers,
  "cabinet-sink": K.CabinetSink,
  "cabinet-corner": K.CabinetCorner,
  "cabinet-cooktop": K.CabinetCooktop,
  island: K.Island,
  "island-overhang": K.IslandOverhang,
  "cabinet-wall": K.CabinetWall,
  "cabinet-wall-glass": K.CabinetWallGlass,
  "open-shelves": K.OpenShelves,
  "cabinet-tall": K.CabinetTall,
  "cabinet-oven-tower": K.CabinetOvenTower,
  vanity: K.Vanity,
  "vanity-double": K.VanityDouble,
  // appliances
  "fridge-french": K.FridgeFrench,
  "fridge-side": K.FridgeSide,
  range: K.Range,
  "range-pro": K.RangePro,
  hood: K.Hood,
  dishwasher: K.Dishwasher,
  microwave: K.Microwave,
  "wine-fridge": K.WineFridge,
  washer: K.Washer,
  dryer: K.Dryer,
  // fixtures
  "sink-farmhouse": K.SinkFarmhouse,
  toilet: K.Toilet,
  tub: K.Tub,
  "tub-alcove": K.TubAlcove,
  shower: K.Shower,
  "pedestal-sink": K.PedestalSink,
  fireplace: K.Fireplace,
  "shower-niche": K.ShowerNiche,
  "pony-wall": K.PonyWall,
  // lighting
  recessed: L.Recessed,
  pendant: L.Pendant,
  "pendant-glass": L.PendantGlass,
  "pendant-trio": L.PendantTrio,
  chandelier: L.Chandelier,
  "flush-mount": L.FlushMount,
  sconce: L.Sconce,
  "floor-lamp": L.FloorLamp,
  "table-lamp": L.TableLamp,
  track: L.Track,
  "under-cab-light": L.UnderCabinetLight,
  // doors & windows
  door: L.Door,
  "door-double": L.DoorDouble,
  "door-sliding": L.DoorSliding,
  doorway: L.Doorway,
  window: L.Window,
  "window-double": L.WindowDouble,
  "window-picture": L.WindowPicture,
  // furniture
  sofa: L.Sofa,
  sectional: L.Sectional,
  armchair: L.Armchair,
  "coffee-table": L.CoffeeTable,
  "side-table": L.SideTable,
  "tv-console": L.TvConsole,
  "dining-table": L.DiningTable,
  "dining-chair": L.DiningChair,
  stool: L.Stool,
  bookshelf: L.Bookshelf,
  bed: L.Bed,
  dresser: L.Dresser,
  nightstand: L.Nightstand,
  desk: L.Desk,
  rug: L.Rug,
  // decor
  plant: L.Plant,
  "plant-small": L.PlantSmall,
  mirror: L.Mirror,
  art: L.Art,
  vase: L.Vase,
};
