class SessionSourceRegistry {
  private readonly files = new Map<string, File>();

  register(sourceKey: string, file: File): void {
    this.files.set(sourceKey, file);
  }

  get(sourceKey: string): File | undefined {
    return this.files.get(sourceKey);
  }

  has(sourceKey: string): boolean {
    return this.files.has(sourceKey);
  }
}

export const sessionSourceRegistry = new SessionSourceRegistry();

