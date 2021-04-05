import {
    Cmp,
    arrayCompare,
    fakeUuid,
    fakeHash,
    keyComparer,
    deepEqual,
} from './utils';

//================================================================================ 

let now = () =>
    Date.now() * 1000;

//================================================================================ 
// BASIC TYPES

type Thunk = () => void;
type Callback<T> = (data: T) => void;
type AsyncCallback<T> = (data: T) => Promise<void>;

type AuthorAddress = string;
type Path = string;
type Signature = string;
type Timestamp = number;
type LocalIndex = number;

interface AuthorKeypair {
    address: AuthorAddress,
    secret: string,
}

//================================================================================ 
// DOCUMENTS

interface Doc {
    // TODO: format
    path: Path,
    timestamp: Timestamp,
    author: AuthorAddress,
    content: string,
    contentHash: string,
    contentLength: number,
    signature: Signature,

    // Local Index:
    // Our docs form a linear sequence with gaps.
    // When a doc is updated (same author, same path, new content), it moves to the
    // end of the sequence and gets a new, higher localIndex.
    // This sequence is specific to this local storage, affected by the order it received
    // documents.
    //
    // It's useful during syncing so that other peers can say "give me everything that's
    // changed since your localIndex 23".
    //
    // This is sent over the wire as part of a Doc so the receiver knows what to ask for next time,
    // but it's then moved into a separate data structure like:
    //    knownPeerHighestLocalIndexes:
    //        peer111: 77
    //        peer222: 140
    // ...which helps us continue syncing with that specific peer next time.
    //
    // When we upsert the doc into our own storage, we discard the other peer's value
    // and replace it with our own localIndex.
    //
    // The localIndex is not included in the doc's signature.
    _localIndex?: LocalIndex,
}

// A partial doc that is about to get written.
// The rest of the properties will be filled in by Bowl.write().
interface DocToWrite {
    path: Path,
    author: AuthorAddress,
    content: string,
}

//================================================================================ 
// DOCUMENT SORTING AND VALIDATION

let combinePathAndAuthor = (doc: Doc) => {
    // This is used as a key into the path&author index
    // It must use a separator character that's not valid in either paths or author addresses
    return `${doc.path}|${doc.author}`;
}

let docComparePathThenNewestFirst = (a: Doc, b: Doc): Cmp => {
    // Sorts docs by path ASC, then breaks ties by timestamp DESC (newest first)
    if (a.signature === b.signature) { return Cmp.EQ; }
    return arrayCompare(
        [a.path, -a.timestamp],
        [b.path, -b.timestamp],
    );
}
let docCompareForOverwrite = (newDoc: Doc, oldDoc: Doc): Cmp => {
    // A doc can overwrite another doc if the timestamp is higher, or
    // if the timestamp is tied, if the signature is higher.
    return arrayCompare(
        [newDoc.timestamp, newDoc.signature],
        [oldDoc.timestamp, oldDoc.signature],
    );
}

let signDoc = (authorKeypair: AuthorKeypair, doc: Doc): void => {
    // TODO: mutate the doc to set the signature.
    doc.signature = 'sig' + fakeUuid();
}

let docIsValid = (doc: Doc): boolean =>
    // TODO: check document validity rules
    true;

//================================================================================ 
// EVENTS AND FOLLOWERS

enum UpsertResult {
    // doc was not saved: negative numbers
    Obsolete = -3,
    AlreadyHadIt = -2,
    Invalid = -1,

    // doc was saved: positive numbers
    AcceptedButNotLatest = 1,
    AcceptedAndLatest = 2,
}

interface WriteEvent {
    // This is only sent on a successful write.
    doc: Doc,

    // Is this doc the latest one at its path (for any author)?
    isLatest: boolean,

    // Prev doc from the same author at this path, if there was one.
    // This may be present no matter the value of isLatest.
    previousDocSameAuthor: Doc | undefined;

    // If this doc isLatest, what was the previous latest doc until just now?
    // It can be from the same author or a different one.
    previousLatestDoc: Doc | undefined;
}

interface Follower {
    // A Follower is a callback that progresses along the LocalIndex of documents

    cb: Callback<Doc> | AsyncCallback<Doc>;

    // The next doc to process.  This should start at zero.
    nextIndex: LocalIndex;

    // Sync followers are synchronous functions.
    // - they block addFollower until they are all caught up.
    // - they block upsert until they have run. 
    //
    // Async followers are async functions.
    // - addFollower does not block
    // - they move along lazily at their own pace along the LocalIndex
    //    until they hit the end, then they go to sleep
    // - they wake up when new docs are upserted
    // - upsert does not wait for these followers to finish
    // - TODO: need another callback or special event so an async follower
    //    can know when it's caught up
    kind: 'sync' | 'async';

    // state, mostly used for async followers
    state?: 'running' | 'sleeping' | 'quitting',
}

let wakeAsyncFollower = (follower: Follower, bowl: Bowl) => {
    // This function is called by Bowl.upsert on async followers that are sleeping,
    //  and on newly added async followers.

    // Change an async follower from 'sleeping' to 'running'
    // It will start work after setImmediate fires.
    // It will continue running until it runs out of docs to process, then go to sleep again.

    if (follower.state !== 'sleeping') { throw new Error('to start, follower should have been already sleeping'); }
    follower.state = 'running';
    setImmediate(() => continueAsyncFollower(follower, bowl));
}

let continueAsyncFollower = async (follower: Follower, bowl: Bowl) => {
    // Continue an async follower that's 'running'.
    // This will call itself over and over using setImmediate until it runs out of docs to process,
    //  then it will go to sleep again.
    // If the state was changed to 'quitting' (from the outside), it will stop early.
    //  (That happens when you unsubscribe it from the Bowl.)

    if (follower.state === 'quitting') { return; }
    if (follower.state === 'sleeping') { throw new Error('to continue, follower should have been already running'); }
    if (follower.nextIndex > bowl.highestLocalIndex) {
        // if we run out of docs to process, go to sleep and stop the thread.
        follower.state = 'sleeping';
        return;
    } else {
        // Since we only run every 4ms we only get to run at most 250 times per second,
        // so let's do a batch of work instead of just one doc.
        let docs = bowl.getDocsSinceLocalIndex(follower.nextIndex, 40);
        for (let doc of docs) {
            // run the callback one at a time in series, waiting for it to finish each time
            await follower.cb(doc);
        }
        // and schedule ourselves to run again in 4ms
        setImmediate(() => continueAsyncFollower(follower, bowl));
    }
}

//================================================================================ 
// QUERY

// ways to filter an individual document with no other context
interface QueryFilter {
    path?: Path,
    pathStartsWith?: string,
    pathEndsWith?: string,
    author?: AuthorAddress,
    timestamp?: Timestamp,
    timestampGt?: Timestamp,
    timestampLt?: Timestamp,
    contentLength?: number,
    contentLengthGt?: number,
    contentLengthLt?: number,
}

interface Query {
    // for each property, the first option is the default if it's omitted

    // this is in the order that processing happens:

    // first, limit to latest docs or all docs
    history?: 'latest' | 'all',

    // then iterate in this order
    //   "path ASC" is actually "path ASC then break ties with timestamp DESC"
    //   "path DESC" is the reverse of that
    orderBy?: 'path ASC' | 'path DESC' | 'localIndex ASC' | 'localIndex DESC';

    // start iterating at this item
    startAt?: {
        // only when ordering by localIndex
        localIndex?: number,
        // only when ordering by path
        path?: string,
    }

    // then apply filters, if any
    filter?: QueryFilter,

    // stop iterating after this number of docs
    limit?: number;
    // TODO: limitBytes
}

let defaultQuery: Query = {
    history: 'latest',
    orderBy: 'path ASC',
    startAt: undefined,
    limit: undefined,
    filter: undefined,
}

let docMatchesFilter = (doc: Doc, filter: QueryFilter): boolean => {
    if (filter.path !== undefined && doc.path !== filter.path) { return false; }
    if (filter.pathStartsWith !== undefined && !doc.path.startsWith(filter.pathStartsWith)) { return false; }
    if (filter.pathEndsWith !== undefined && !doc.path.startsWith(filter.pathEndsWith)) { return false; }
    if (filter.author !== undefined && doc.author !== filter.author) { return false; }
    if (filter.timestamp !== undefined && doc.timestamp !== filter.timestamp) { return false; }
    if (filter.timestampGt !== undefined && !(doc.timestamp > filter.timestampGt)) { return false; }
    if (filter.timestampLt !== undefined && !(doc.timestamp > filter.timestampLt)) { return false; }
    if (filter.contentLength !== undefined && doc.contentLength !== filter.contentLength) { return false; }
    if (filter.contentLengthGt !== undefined && !(doc.contentLength > filter.contentLengthGt)) { return false; }
    if (filter.contentLengthLt !== undefined && !(doc.contentLength > filter.contentLengthLt)) { return false; }
    return true;
}

//================================================================================ 

class Bowl {
    // The max local index used so far.  the first doc will increment this and get index 1.
    highestLocalIndex: LocalIndex = 0;

    // Our indexes.
    // these maps hold the same Doc objects, so memory usage is not awful.
    // the Doc objects are frozen.
    docWithLocalIndex: Map<LocalIndex, Doc> = new Map();  // localIndx --> doc
    docWithPathAndAuthor: Map<Path, Doc> = new Map();     // path+author --> doc
    docsByPathNewestFirst: Map<Path, Doc[]> = new Map();  // path --> array of docs with that path, sorted newest first

    // callbacks and followers
    onWriteCbs: Set<Callback<WriteEvent>> = new Set();
    followers: Set<Follower> = new Set();

    constructor() {
    }

    //--------------------------------------------------
    // CALLBACKS AND FOLLOWERS

    onWrite(cb: Callback<WriteEvent>): Thunk {
        this.onWriteCbs.add(cb);
        // return an unsubscribe function
        return () => this.onWriteCbs.delete(cb);
    }

    addFollower(follower: Follower): Thunk {
        follower.state = 'sleeping';
        this.followers.add(follower);

        if (follower.kind === 'sync') {
            // catch up now, synchronously
            follower.state = 'running';
            for (let doc of this.getDocsSinceLocalIndex(follower.nextIndex)) {
                follower.cb(doc);
            }
            follower.state = 'sleeping';
        } else {
            // async followers get started here and will proceed at their own pace
            wakeAsyncFollower(follower, this);
        }

        // return an unsubscribe function which also stops the thread
        return () => {
            follower.state = 'sleeping';
            this.followers.delete(follower);
        }
    }

    getDocsSinceLocalIndex(startAt: LocalIndex, limit?: number): Doc[] {
        // Return an array of docs with locaIndex >= startAt, with up to limit items.
        // Limit defaults to infinity.
        let docs = [];
        for (let ii = startAt; ii <= this.highestLocalIndex; ii++) {
            let doc = this.docWithLocalIndex.get(ii);
            if (doc) { docs.push(doc); }
            if (limit !== undefined && docs.length === limit) {
                return docs;
            }
        }
        return docs;
    }

    //--------------------------------------------------
    // GET

    getAllDocs(sort: boolean = true): Doc[] {
        // All docs, sorted by path ASC then timestamp DESC.
        let docs = [...this.docWithLocalIndex.values()];
        if (sort) {
            docs.sort(docComparePathThenNewestFirst);
        }
        return docs;
    }
    getLatestDocs(sort: boolean = true): Doc[] {
        // The latest doc for each path, sorted by path ASC.
        let docs: Doc[] = [];
        for (let docArray of this.docsByPathNewestFirst.values()) {
            docs.push(docArray[0]);
        }
        if (sort) {
            docs.sort(keyComparer('path'));
        }
        return docs;
    }
    getAllDocsAtPath(path: Path): Doc[] | undefined {
        // All docs at a given path, sorted newest first.
        return this.docsByPathNewestFirst.get(path);
    }
    getLatestDocAtPath(path: Path): Doc | undefined {
        // The one latest doc at a given path.
        let docs = this.docsByPathNewestFirst.get(path);
        if (!docs) { return undefined; }
        return docs[0];
    }
    queryDocs(query?: Query): Doc[] {
        // Query the documents.

        query = { ...defaultQuery, ...query };

        // get history docs or all docs
        let docs = query.history === 'all'
            ? this.getAllDocs(false)   // don't sort it here,
            : this.getLatestDocs(false);  // we'll sort it below

        // orderBy
        if (query.orderBy?.startsWith('path')) {
            docs.sort(docComparePathThenNewestFirst);
        } else if (query.orderBy?.startsWith('localIndex')) {
            docs.sort(keyComparer('_localIndex'));
        }

        if (query.orderBy?.endsWith(' DESC')) {
            docs.reverse();
        }

        let filteredDocs: Doc[] = [];
        for (let doc of docs) {
            // skip ahead until we pass continueAfter
            if (query.orderBy === 'path ASC') {
                if (query.startAt !== undefined) {
                    if (query.startAt.path !== undefined && doc.path < query.startAt.path) { continue; }
                    // doc.path is now >= startAt.path
                }
            }
            if (query.orderBy === 'path DESC') {
                if (query.startAt !== undefined) {
                    if (query.startAt.path !== undefined && doc.path > query.startAt.path) { continue; }
                    // doc.path is now <= startAt.path (we're descending)
                }
            }
            if (query.orderBy === 'localIndex ASC') {
                if (query.startAt !== undefined) {
                    if (query.startAt.localIndex !== undefined && (doc._localIndex || 0) < query.startAt.localIndex) { continue; }
                    // doc.path is now >= startAt.localIndex
                }
            }
            if (query.orderBy === 'localIndex DESC') {
                if (query.startAt !== undefined) {
                    if (query.startAt.localIndex !== undefined && (doc._localIndex || 0) > query.startAt.localIndex) { continue; }
                    // doc.path is now <= startAt.localIndex (we're descending)
                }
            }

            // apply filter: skip docs that don't match
            if (query.filter && !docMatchesFilter(doc, query.filter)) { continue; }
            filteredDocs.push(doc);

            // stop when hitting limit
            if (query.limit !== undefined && filteredDocs.length >= query.limit) { break; }

            // TODO: limitBytes
        }

        return filteredDocs;
    }

    queryPaths(query?: Query): Path[] {
        // If query is provided:
        // - find docs
        // - get their paths
        // - remove duplicates
        // - sort in ascending order by path unless query has orderBy: 'path DESC'
        //
        // If query is NOT provided:
        // - return all unique paths in ascending order.

        let paths: Path[];
        if (query === undefined || deepEqual(query, {})) {
            // no query
            // just get list of unique paths
            paths = [...this.docsByPathNewestFirst.keys()];
        } else {
            // query was provided
            // do the query, extract paths, remove duplicates
            let docs = this.queryDocs(query);
            paths = docs.map(doc => doc.path);
            paths = [...new Set(paths)];
        }
        paths.sort();
        if (query !== undefined && query.orderBy === 'path DESC') {
            paths.reverse();
        }
        return paths;
    }

    queryAuthors(query?: Query): AuthorAddress[] {
        // If query is provided:
        // - find docs
        // - get their author addresses
        // - remove duplicates
        // - sort in ascending order by author address
        //
        // If query is NOT provided:
        // - return all unique author addresses in ascending order.
        let authors: AuthorAddress[];
        if (query === undefined || deepEqual(query, {})) {
            // no query
            // just get all unique authors from all docs
            let authorsSet = new Set<AuthorAddress>();
            for (let doc of this.docWithPathAndAuthor.values()) {
                authorsSet.add(doc.author);
            }
            authors = [...authorsSet];
        } else {
            // query was provided
            // do the query, extract authors, remove duplicates
            let docs = this.queryDocs(query || {});
            authors = docs.map(doc => doc.author);
            authors = [...new Set<AuthorAddress>(authors)];
        }
        authors.sort();
        return authors;
    }

    //--------------------------------------------------
    // SET

    write(keypair: AuthorKeypair, docToWrite: DocToWrite): UpsertResult {
        // Prepare and sign a locally made doc, then upsert it.

        // Sets the timestamp to now, but then bumps the timestamp ahead
        // to win over any existing docs from any author.
        // (This means that one author's writes may have non-monotonic timestamps
        //  from path to path).
        let existingDocSamePath = this.getLatestDocAtPath(docToWrite.path);
        let doc: Doc = {
            path: docToWrite.path,
            timestamp: existingDocSamePath === undefined ? now() : existingDocSamePath.timestamp + 1,
            author: keypair.address,
            content: docToWrite.content,
            contentHash: fakeHash(docToWrite.content), // TODO: real hash
            contentLength: Buffer.byteLength(docToWrite.content),
            signature: '?',  // signature will be added in just a moment
            // _localIndex will be added during upsert.  it's not needed for the signature.
        }
        signDoc(keypair, doc);
        return this.upsert(doc);
    }

    upsert(doc: Doc): UpsertResult {
        // Add an already-signed doc obtained from write() or from another peer.

        // This sets doc._localIndex, overwriting the value from elsewhere,
        // then freezes the doc object.  (All docs stored in this Bowl are frozen.)

        if (!docIsValid(doc)) { return UpsertResult.Invalid; }

        // Check if it wins over same author's previous doc at this path.
        // If not, it's obsolete or we already have it, and we ignore it.
        let pathAndAuthor = combinePathAndAuthor(doc);
        let existingDocSameAuthor = this.docWithPathAndAuthor.get(pathAndAuthor);
        if (existingDocSameAuthor) {
            let docComp = docCompareForOverwrite(doc, existingDocSameAuthor);
            if (docComp === Cmp.LT) { return UpsertResult.Obsolete; }
            if (docComp === Cmp.EQ) { return UpsertResult.AlreadyHadIt; }
        }

        // At this point, either the doc is newer (relative to same path and author)
        // or there was no existing one with same path and author.
        // So let's save it.

        // Put into array of existing docs at this path.
        // Create a new array if needed.
        let existingDocsSamePath = this.docsByPathNewestFirst.get(doc.path) || [];
        existingDocsSamePath.push(doc);
        // And keep the list sorted by timestamp (newest first)
        existingDocsSamePath.sort(docComparePathThenNewestFirst);

        // Set the localIndex and freeze the doc
        this.highestLocalIndex += 1;
        doc._localIndex = this.highestLocalIndex;
        Object.freeze(doc);

        // Save it into our index Maps
        this.docWithLocalIndex.set(this.highestLocalIndex, doc);
        this.docsByPathNewestFirst.set(doc.path, existingDocsSamePath);
        this.docWithPathAndAuthor.set(pathAndAuthor, doc);

        // Check if it's the new latest doc at this path
        // so we know the details for the WriteEvent
        let upsertResult: UpsertResult;
        let previousLatestDoc: Doc | undefined = undefined;
        if (existingDocsSamePath[0] === doc) {
            upsertResult = UpsertResult.AcceptedAndLatest;
            if (existingDocsSamePath.length > 1) {
                previousLatestDoc = existingDocsSamePath[1];
            }
        } else {
            upsertResult = UpsertResult.AcceptedButNotLatest;
        }

        // send events
        for (let cb of this.onWriteCbs) {
            cb({
                doc,
                isLatest: upsertResult === UpsertResult.AcceptedAndLatest,
                previousDocSameAuthor: existingDocSameAuthor,
                previousLatestDoc,
            });
        }

        // update followers
        for (let follower of this.followers) {
            if (follower.kind === 'sync') {
                // sync followers run right now
                follower.nextIndex = this.highestLocalIndex + 1;
                follower.cb(doc);
            } else {
                // wake up async followers that are sleeping.
                // they will continue at their own pace until they run out of docs to process,
                // then go to sleep again.
                if (follower.state === 'sleeping') {
                    wakeAsyncFollower(follower, this);
                }
            }
        }

        return upsertResult;
    }
}

