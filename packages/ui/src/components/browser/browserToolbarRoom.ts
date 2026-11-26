const ADDRESS_ROOM_PX = 144;
const ACTION_GAP_PX = 2;
const MORE_GAP_PX = 10;

type ToolbarRowRoom = {
  readonly rowWidth: number;
  readonly takenWidth: number;
  readonly buttonWidth: number;
};

export const rowActionsThatFit = ({ rowWidth, takenWidth, buttonWidth }: ToolbarRowRoom): number => {
  if (buttonWidth <= 0) return 0;
  const forActions = rowWidth - takenWidth - ADDRESS_ROOM_PX - MORE_GAP_PX - buttonWidth + ACTION_GAP_PX;
  return Math.max(0, Math.floor(forActions / (buttonWidth + ACTION_GAP_PX)));
};
