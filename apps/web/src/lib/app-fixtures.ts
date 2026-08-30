export interface ReceiptFixture {
  readonly id: string;
  readonly time: string;
  readonly machineTime: string;
  readonly outcome: string;
  readonly detail: string;
  readonly destination: string;
  readonly selected: boolean;
}

export const receiptFixtures: readonly ReceiptFixture[] = [
  {
    id: "shopping",
    time: "9:41 AM",
    machineTime: "2026-08-30T09:41:00-07:00",
    outcome: "Added to Shopping",
    detail: "Milk, eggs, bread",
    destination: "Shopping",
    selected: false
  },
  {
    id: "workout",
    time: "9:32 AM",
    machineTime: "2026-08-30T09:32:00-07:00",
    outcome: "Updated Push Workout",
    detail: "Incline DB press 4x8",
    destination: "Health / Workouts",
    selected: false
  },
  {
    id: "mindset",
    time: "9:21 AM",
    machineTime: "2026-08-30T09:21:00-07:00",
    outcome: "Added to Mindset",
    detail: "Roosevelt method: tell people you can do it, then figure out how",
    destination: "Mindset / Principles",
    selected: true
  }
] as const;
