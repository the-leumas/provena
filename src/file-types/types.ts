export interface FileTypeDefinition {
  readonly extensions: readonly string[];
  readonly kind: 'document' | 'code' | 'configuration';
  readonly language: string;
  readonly parserId: string;
  readonly indexable: boolean;
  readonly structureAware: boolean;
  readonly textFallback: boolean;
  readonly mimeTypes: readonly string[];
  readonly maxBytes: number;
}
