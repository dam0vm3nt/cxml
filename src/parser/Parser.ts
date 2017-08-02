import * as path from 'path';
import * as stream from 'stream';
import * as nbind from 'nbind';
import * as ParserLib from './Lib';

import { ArrayType } from '../tokenizer/Buffer';
import { Token } from '../tokenizer/Token';
import { Namespace } from '../Namespace';

const lib = nbind.init<typeof ParserLib>(path.resolve(__dirname, '../..')).lib;

export const ParserConfig = lib.ParserConfig;
export type ParserConfig = ParserLib.ParserConfig;

export const RawNamespace = lib.Namespace;
export type RawNamespace = ParserLib.Namespace;

export type TokenBuffer = (number | Token | string)[];

// const tokenBufferSize = 2;
// const tokenBufferSize = 3;
const tokenBufferSize = 8192;

const enum TOKEN {
	SHIFT = 5,
	MASK = 31
}

/** Copypasted from Parser.h. */
const enum CodeType {
	OPEN_ELEMENT_ID = 0,
	CLOSE_ELEMENT_ID,
	ATTRIBUTE_ID,
	PROCESSING_ID,

	ATTRIBUTE_START_OFFSET,
	ATTRIBUTE_END_OFFSET,

	TEXT_START_OFFSET,
	TEXT_END_OFFSET,

	COMMENT_START_OFFSET,
	COMMENT_END_OFFSET,

	// Unrecognized element name.
	UNKNOWN_START_OFFSET,

	// The order of these must match OPEN_ELEMENT_ID, CLOSE_ELEMENT_ID...
	UNKNOWN_OPEN_ELEMENT_END_OFFSET,
	UNKNOWN_CLOSE_ELEMENT_END_OFFSET,
	UNKNOWN_ATTRIBUTE_END_OFFSET,
	UNKNOWN_PROCESSING_END_OFFSET,

	PROCESSING_END_TYPE,

	// Recognized prefix from an unrecognized name.
	PREFIX_NAME_LEN,
	PREFIX_NAME_ID
}

export const enum TokenType {
	OPEN_ELEMENT = 0,
	CLOSE_ELEMENT,
	ATTRIBUTE,
	PROCESSING,

	VALUE,
	TEXT,

	COMMENT,

	UNKNOWN_OPEN_ELEMENT,
	UNKNOWN_CLOSE_ELEMENT,
	UNKNOWN_ATTRIBUTE,
	UNKNOWN_PROCESSING,

	XML_PROCESSING_END,
	SGML_PROCESSING_END
}

let tokenTypeTbl: TokenType[] = [];

// Make sure these codes match without the table:
// tokenTypeTbl[CodeType.OPEN_ELEMENT_ID] = TokenType.OPEN_ELEMENT;
// tokenTypeTbl[CodeType.CLOSE_ELEMENT_ID] = TokenType.CLOSE_ELEMENT;
// tokenTypeTbl[CodeType.ATTRIBUTE_ID] = TokenType.ATTRIBUTE;
// tokenTypeTbl[CodeType.PROCESSING_ID] = TokenType.PROCESSING;

tokenTypeTbl[CodeType.ATTRIBUTE_END_OFFSET] = TokenType.VALUE;
tokenTypeTbl[CodeType.TEXT_END_OFFSET] = TokenType.TEXT;
tokenTypeTbl[CodeType.COMMENT_END_OFFSET] = TokenType.COMMENT;

tokenTypeTbl[CodeType.UNKNOWN_OPEN_ELEMENT_END_OFFSET] = TokenType.UNKNOWN_OPEN_ELEMENT;
tokenTypeTbl[CodeType.UNKNOWN_CLOSE_ELEMENT_END_OFFSET] = TokenType.UNKNOWN_CLOSE_ELEMENT;
tokenTypeTbl[CodeType.UNKNOWN_ATTRIBUTE_END_OFFSET] = TokenType.UNKNOWN_ATTRIBUTE;
tokenTypeTbl[CodeType.UNKNOWN_PROCESSING_END_OFFSET] = TokenType.UNKNOWN_PROCESSING;

export class Parser extends stream.Transform {
	constructor(config: ParserConfig) {
		super({ objectMode: true });

		this.parser = new lib.Parser(config);

		this.codeBuffer = new Uint32Array(tokenBufferSize);
		this.parser.setTokenBuffer(this.codeBuffer, () => this.parseTokenBuffer(true));
	}

	_transform(chunk: string | Buffer, enc: string, flush: (err: any, chunk: TokenBuffer) => void) {
		this.chunk = chunk;
		this.flush = flush;
		this.getSlice = (typeof(chunk) == 'string') ? this.getStringSlice : this.getBufferSlice;
		this.parser.parse(chunk as Buffer);
		this.parseTokenBuffer(false);
	}

	private parseTokenBuffer(pending: boolean) {
		const codeBuffer = this.codeBuffer;
		const codeCount = codeBuffer[0];

		let codeNum = 0;
		let partStart = this.partStart;
		let prefixLen = this.prefixLen;

		const tokenBuffer = this.tokenBuffer;
		const tokenList = Token.list;
		let tokenNum = 0;
		let token: Token;

		while(codeNum < codeCount) {
			let code = codeBuffer[++codeNum];
			const kind = code & TOKEN.MASK;
			code >>= TOKEN.SHIFT;

			switch(kind) {
				case CodeType.OPEN_ELEMENT_ID:
				case CodeType.CLOSE_ELEMENT_ID:
				case CodeType.ATTRIBUTE_ID:
				case CodeType.PROCESSING_ID:

					tokenBuffer[++tokenNum] = kind as TokenType;
					tokenBuffer[++tokenNum] = tokenList[code];
					break;

				case CodeType.TEXT_START_OFFSET:
				case CodeType.ATTRIBUTE_START_OFFSET:
				case CodeType.COMMENT_START_OFFSET:
				case CodeType.UNKNOWN_START_OFFSET:

					partStart = code;
					break;

				case CodeType.COMMENT_END_OFFSET:

					tokenBuffer[++tokenNum] = TokenType.COMMENT;
					tokenBuffer[++tokenNum] = this.getSlice(partStart, code);
					partStart = -1;
					break;

				case CodeType.ATTRIBUTE_END_OFFSET:
				case CodeType.TEXT_END_OFFSET:
				case CodeType.UNKNOWN_OPEN_ELEMENT_END_OFFSET:
				case CodeType.UNKNOWN_CLOSE_ELEMENT_END_OFFSET:
				case CodeType.UNKNOWN_ATTRIBUTE_END_OFFSET:
				case CodeType.UNKNOWN_PROCESSING_END_OFFSET:

					tokenBuffer[++tokenNum] = tokenTypeTbl[kind];
					tokenBuffer[++tokenNum] = this.getSlice(partStart, code);
					partStart = -1;
					break;

				case CodeType.PREFIX_NAME_LEN:

					prefixLen = code;
					break;

				case CodeType.PREFIX_NAME_ID:

					if(!this.partList) this.partList = [];
					this.partList.push(tokenList[code].name.substr(0, prefixLen));
					this.bufferPartList = null;
					break;

				case CodeType.PROCESSING_END_TYPE:

					tokenBuffer[++tokenNum] = (
						code ?
						TokenType.SGML_PROCESSING_END :
						TokenType.XML_PROCESSING_END
					);
					break;

				default:

					break;
			}
		}

		if(!pending && partStart >= 0) {
			this.storeSlice(partStart);
			partStart = 0;
		}

		this.partStart = partStart;
		this.prefixLen = prefixLen;
		tokenBuffer[0] = tokenNum;

		this.flush(null, tokenBuffer);
	}

	private storeSlice(start: number, end?: number) {
		if(!this.partList) this.partList = [];

		if(typeof(this.chunk) == 'string') {
			this.bufferPartList = null;
			this.partList.push(this.chunk.substring(start, end));
		} else {
			if(!this.bufferPartList) {
				this.bufferPartList = [];
				this.partList.push(this.bufferPartList);
			}
			this.bufferPartList.push(this.chunk.slice(start, end));
		}
	}

	/** Get a string from the input buffer. Prepend any parts left from
	  * previous code buffers. */
	private getSlice: (start: number, end?: number) => string;

	/** Universal getSlice handler for concatenating buffer parts. */
	private buildSlice(start: number, end?: number) {
		this.storeSlice(start, end);

		const result = this.partList!.map((part: string | Buffer[]) =>
			typeof(part) == 'string' ? part : Buffer.concat(part).toString('utf-8')
		).join('');

		this.bufferPartList = null;
		this.partList = null;

		return(result);
	}

	/** Fast single-part getSlice handler for string buffers. */
	private getStringSlice(start: number, end?: number) {
		return((
			this.partList ? this.buildSlice(start, end) :
			this.chunk.slice(start, end) as string
		).replace(/\r\n?|\n\r/g, '\n'));
	}

	/** Fast single-part getSlice handler for Node.js Buffers. */
	private getBufferSlice(start: number, end?: number) {
		return((
			this.partList ? this.buildSlice(start, end) :
			(this.chunk as Buffer).toString('utf-8', start, end)
		).replace(/\r\n?|\n\r/g, '\n'));
	}

	/** Current input buffer. */
	private chunk: string | Buffer;

	private flush: (err: any, chunk: TokenBuffer) => void;

	private bufferPartList: Buffer[] | null;
	/** Storage for parts of strings split between code or input buffers. */
	private partList: (string | Buffer[])[] | null;

	/** Offset to start of text in input buffer, or -1 if not reading text. */
	private partStart = -1;

	private prefixLen: number;

	private parser: ParserLib.Parser;
	private codeBuffer: Uint32Array;
	private tokenBuffer: TokenBuffer = [];
}
