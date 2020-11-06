import { HardCodedValues } from '../interfaces/hard-coded-values.interface';
import { Parser } from '../interfaces/parser.interface';
import { TokenFiles } from '../interfaces/token-files.interface';
import { TokenGroup } from '../interfaces/token-group.interface';
import { Token } from '../interfaces/token.interface';
import { parse as parseCommentBlock } from './comment-parser';

const mensch: any = require('mensch');

export class CssParser implements Parser {
  public parse(
    tokenFiles: TokenFiles
  ): {
    hardCodedValues: HardCodedValues[];
    keyframes: string;
    tokenGroups: TokenGroup[];
  } {
    const tokenGroups = this.mapTokenFilesToTokenGroups(tokenFiles);

    return {
      hardCodedValues: this.mapTokenFilesToHardCodedValues(
        tokenFiles,
        tokenGroups
      ),
      keyframes: this.mapTokenFilesToKeyframes(tokenFiles),
      tokenGroups
    };
  }

  private mapTokenFilesToHardCodedValues(
    tokenFiles: TokenFiles,
    tokenGroups: TokenGroup[]
  ): HardCodedValues[] {
    if (!tokenFiles || !tokenFiles.css) {
      return [];
    }

    const tokens = tokenGroups.map((tokenGroup) => tokenGroup.tokens).flat();
    const declarations = tokenFiles.css
      .map((tokenFile) => {
        return mensch
          .parse(tokenFile.content, {
            comments: true,
            position: true
          })
          .stylesheet.rules.map(
            (rule) =>
              rule.declarations &&
              rule.declarations
                .filter((declaration) => declaration.type === 'property')
                .map((declaration) => ({
                  ...declaration,
                  filename: tokenFile.filename
                }))
          )
          .flat();
      })
      .flat()
      .filter((item) => !!item && item.name.indexOf('--') !== 0);

    return tokens
      .map((token) => ({
        token,
        values: declarations
          .filter(
            (declaration) =>
              declaration.value && declaration.value.indexOf(token.value) > -1
          )
          .map((declaration) => ({
            file: declaration.filename,
            line: declaration.position.start.line,
            value: declaration.value
          }))
      }))
      .filter((item) => item.values.length > 0);
  }

  private mapTokenFilesToKeyframes(tokenFiles: TokenFiles): string {
    if (!tokenFiles || !tokenFiles.css) {
      return '';
    }

    return tokenFiles.css
      .map((tokenFile) => {
        const parsed = {
          type: 'stylesheet',
          stylesheet: {
            rules: mensch
              .parse(tokenFile.content, {
                comments: true,
                position: true
              })
              .stylesheet.rules.filter((rule: any) => rule.type === 'keyframes')
          }
        };

        return mensch.stringify(parsed);
      })
      .flat()
      .join('');
  }

  private mapTokenFilesToTokenGroups(tokenFiles: TokenFiles): TokenGroup[] {
    if (!tokenFiles || !tokenFiles.css) {
      return [];
    }

    const parsedTokenFiles: any[] = tokenFiles.css.map((tokenFile) => {
      return mensch.parse(tokenFile.content, {
        comments: true,
        position: true
      }).stylesheet.rules;
    });

    return parsedTokenFiles
      .map((tokenFile) => {
        const tokenGroups = tokenFile
          .filter(
            (item: any) =>
              item.type === 'comment' && item.text.indexOf('@tokens') > -1
          )
          .map((item: any) => ({
            ...item,
            parsedText: this.parseCommentBlock(item.text)
          }))
          .map((item: any, index: number, items: any[]) =>
            this.mapTokenGroup(
              item,
              items[index + 1],
              tokenFile,
              parsedTokenFiles
            )
          );

        return tokenGroups;
      })
      .flat();
  }

  private mapTokenGroup(
    item: any,
    nextItem: any,
    parsedTokenFile: any[],
    parsedTokenFiles: any[]
  ): TokenGroup {
    const presenterTag = item.parsedText.tags.find(
      (t: any) => t.tag === 'presenter'
    );

    return this.addTokensToTokenGroup(
      {
        label: item.parsedText.tags
          .find((t: any) => t.tag === 'tokens')
          .source.replace('@tokens', '')
          .trim(),
        position: {
          start: item.position.start.line,
          end: nextItem ? nextItem.position.start.line - 1 : Infinity
        },
        presenter: presenterTag ? presenterTag.name : undefined,
        tokens: [] as Token[]
      },
      parsedTokenFile,
      parsedTokenFiles
    );
  }

  private addTokensToTokenGroup(
    tokenGroup: TokenGroup,
    parsedTokenFile: any[],
    parsedTokenFiles: any[]
  ): TokenGroup {
    const relevantRules: any = parsedTokenFile
      .filter((item) => item.type === 'rule')
      .find(
        (item) =>
          item.position.start.line >= tokenGroup.position.start &&
          item.position.end.line <= tokenGroup.position.end
      );

    const tokens: Token[] = !relevantRules
      ? []
      : relevantRules.declarations
          .map((declaration: any, index: number, declarations: any[]) => {
            const nextDeclaration = declarations[index + 1];

            return {
              ...declaration,
              description:
                nextDeclaration && nextDeclaration.type === 'comment'
                  ? nextDeclaration.text.replace(/\*/g, '').trim()
                  : ''
            };
          })
          .filter(
            (declaration: any) =>
              declaration.type === 'property' && declaration.name.match(/^--/)
          )
          .map((declaration: any, index: number, declarations: any[]) => {
            const declarationsFromOtherFiles: any[] = parsedTokenFiles
              .map((tokenFile) => {
                return tokenFile
                  .filter((item) => item.type === 'rule')
                  .map((item) => item.declarations)
                  .map((declarations: any) => {
                    return declarations.filter(
                      (declaration) =>
                        declaration.type === 'property' &&
                        declaration.name.match(/^--/)
                    );
                  });
              })
              .flat(Infinity);

            let tokenValue = declaration.value;

            if (declaration.value.startsWith('var(')) {
              const variableNameMatch = declaration.value.match(
                /^var\((--.+)\)$/
              );

              if (variableNameMatch.length > 0) {
                const variableName = variableNameMatch[1];
                const referencedDeclaration = declarationsFromOtherFiles.find(
                  (decl) => decl.name === variableName
                );

                if (referencedDeclaration) {
                  tokenValue = referencedDeclaration.value;
                }
              }
            }

            const aliases = declarationsFromOtherFiles
              .filter((d) => d.value === `var(${declaration.name})`)
              .map((declaration) => declaration.name);

            return {
              aliases,
              description: declaration.description,
              editable: true,
              key: declaration.name,
              value: tokenValue
            };
          })
          .filter((token: Token, _: number, tokens: Token[]) => {
            return (
              !token.value.match(/^var\(--.+/) &&
              !tokens.some(
                (t) =>
                  t.key !== token.key && t.aliases.some((a) => a === token.key)
              )
            );
          });

    return { ...tokenGroup, tokens };
  }

  private parseCommentBlock(string: string): any {
    return parseCommentBlock(`/*${string}*/`)[0];
  }
}
