import { SemanticSearchEngine } from '@theleumas/provena';
import { FileSystemFolderSource, FileIndexStorage } from '@theleumas/provena/filesystem';
/** Host chooses an approved absolute root and an index filename outside that root. */
export async function searchFolder(root, indexFilename, query) {
    const engine = new SemanticSearchEngine({ storage: new FileIndexStorage(indexFilename) });
    engine.addSource(new FileSystemFolderSource({ id: 'folder', root }));
    await engine.initialize();
    return engine.search({ query, mode: 'lexical' });
}
