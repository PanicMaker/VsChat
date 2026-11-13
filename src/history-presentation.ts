import { ChatMessage } from './types';
import { MarkdownNode, MAX_MARKDOWN_LENGTH, parseMarkdown } from './markdown-content';

const MEDIA_CONCURRENCY = 4;
const MEDIA_CACHE_BYTES = 16 * 1024 * 1024;
const MEDIA_CACHE_ENTRIES = 128;
const TEXT_CACHE_CHARACTERS = 256 * 1024;
const TEXT_CACHE_ENTRIES = 256;

/** Bounded presentation caches; database records remain the source of truth. */
export class HistoryPresentation {
  private revision: string | undefined;
  private epoch = 0;
  private images = new Map<string, { value: string; size: number }>();
  private imageBytes = 0;
  private text = new Map<string, MarkdownNode[] | undefined>();
  private textCharacters = 0;

  constructor(private readImage: (id: number, partIndex?: number) => Promise<string | undefined>,
    private onImageError: (id: number, partIndex: number | undefined, error: unknown) => void,
    private parse: typeof parseMarkdown = parseMarkdown,
    private allowRemoteImages = true) {}

  private markdown(source: string): MarkdownNode[] | undefined {
    if (source.length > MAX_MARKDOWN_LENGTH) return undefined;
    if (this.text.has(source)) {
      const value = this.text.get(source);
      this.text.delete(source);
      this.text.set(source, value);
      return value;
    }
    const value = this.parse(source);
    this.text.set(source, value);
    this.textCharacters += source.length;
    while (this.text.size > TEXT_CACHE_ENTRIES || this.textCharacters > TEXT_CACHE_CHARACTERS) {
      const oldest = this.text.keys().next().value!;
      this.textCharacters -= oldest.length;
      this.text.delete(oldest);
    }
    return value;
  }

  private async image(id: number, partIndex: number | undefined, epoch: number): Promise<string | undefined> {
    const key = `${id}:${partIndex ?? 'legacy'}`;
    const cached = epoch === this.epoch ? this.images.get(key) : undefined;
    if (cached) {
      this.images.delete(key);
      this.images.set(key, cached);
      return cached.value;
    }
    try {
      const value = await this.readImage(id, partIndex);
      // Missing images are retried: files can become ready after their rows.
      if (typeof value !== 'string' || !value) return undefined;
      const size = value.length * 2;
      if (epoch === this.epoch && size <= MEDIA_CACHE_BYTES) {
        const previous = this.images.get(key);
        if (previous) this.imageBytes -= previous.size;
        this.images.delete(key);
        this.images.set(key, { value, size });
        this.imageBytes += size;
        while (this.imageBytes > MEDIA_CACHE_BYTES || this.images.size > MEDIA_CACHE_ENTRIES) {
          const oldest = this.images.keys().next().value!;
          this.imageBytes -= this.images.get(oldest)!.size;
          this.images.delete(oldest);
        }
      }
      return value;
    } catch (error) {
      this.onImageError(id, partIndex, error);
      return undefined;
    }
  }

  async hydrate(messages: ChatMessage[], revision: string): Promise<ChatMessage[]> {
    if (this.revision !== revision) {
      this.revision = revision;
      this.epoch++;
      this.images.clear();
      this.imageBytes = 0;
    }
    const epoch = this.epoch;
    const work: Array<() => Promise<void>> = [];
    const output = messages.map(message => {
      const result = { ...message };
      // WeChat media must pass the host's bounded download/decryption path.
      // Imported records must not initiate network requests merely by viewing.
      const localImagesOnly = !this.allowRemoteImages || Boolean(message.restored);
      const imageValue = (value: string | undefined) => !localImagesOnly || (typeof value === 'string'
        && /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z\d+/]+={0,2}$/i.test(value)) ? value : undefined;
      if (message.parts?.length) {
        result.parts = message.parts.map((part, index) => {
          const hydrated = { ...part };
          if (part.type === 1 && part.text) hydrated.markdown = this.markdown(part.text);
          if (part.type === 2) {
            if (localImagesOnly) delete hydrated.url;
            work.push(async () => {
              hydrated.imageDataUrl = imageValue(await this.image(message.id, index, epoch))
                || (!localImagesOnly ? part.url : undefined);
            });
          }
          return hydrated;
        });
      } else if (message.type === 1) result.markdown = this.markdown(message.content);
      else if (message.type === 2) {
        if (localImagesOnly) {
          result.content = '[图片]';
          delete (result as ChatMessage & { imageDataUrl?: string }).imageDataUrl;
        }
        work.push(async () => {
          const url = imageValue(await this.image(message.id, undefined, epoch))
            || (!localImagesOnly && message.content?.startsWith('http') ? message.content : undefined);
          if (url) Object.assign(result, { imageDataUrl: url });
        });
      }
      return result;
    });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(MEDIA_CONCURRENCY, work.length) }, async () => {
      while (next < work.length) await work[next++]();
    }));
    return output;
  }

  clear(): void {
    this.epoch++;
    this.revision = undefined;
    this.images.clear();
    this.imageBytes = 0;
    this.text.clear();
    this.textCharacters = 0;
  }
}
