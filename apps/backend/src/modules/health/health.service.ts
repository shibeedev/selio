export class HealthService {
  constructor(private readonly ping: () => void) {}

  isReady(): boolean {
    try {
      this.ping();
      return true;
    } catch {
      return false;
    }
  }
}
