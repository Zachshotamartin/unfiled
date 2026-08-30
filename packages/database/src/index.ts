export type DatabaseJson =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: DatabaseJson | undefined }
  | readonly DatabaseJson[];

export type TransactionResult<T> = Readonly<{
  value: T;
  replayed: boolean;
}>;
