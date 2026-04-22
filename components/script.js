const categoriasPredefinidas = [
    {
        id: '',
        nome: 'Todas',
        emoji: '📋'
    },
    {
        id: 'almoco',
        nome: 'Almoço',
        emoji: '🍛'
    },
    { 
        id: 'cafe',
        nome: 'Café',
        emoji: '☕'
    },
    {
        id: 'doce',
        nome: 'Doce',
        emoji: '🍰'
    },
    {
        id: 'diversos',
        nome: 'Diversos',
        emoji: '🥘'
    },
    {
        id: 'drink',
        nome: 'Drink',
        emoji: '🍹'
    },
    {
        id: 'especial',
        nome: 'Especial',
        emoji: '🍷'
    },
    {
        id: 'jantar',
        nome: 'Jantar',
        emoji: '🥗'
    },
    {
        id: 'lanche',
        nome: 'Lanche',
        emoji: '🍔'
    },
    {
        id: 'petiscos',
        nome: 'Petiscos',
        emoji: '🍢'
    },
    {
        id: 'restricoes',
        nome: 'Restrições',
        emoji: '🥛'
    }
];

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const CONFIG = Object.freeze({
    API_TIMEOUT: 10000,
    RETRY_BASE_DELAY: 1000,
    MAX_RETRIES: 3,
    MODAL_AUTO_CLOSE: 3000,
    MAX_TOKENS: 1400
});

const SYSTEM_PROMPT = `Você é um chef brasileiro prático e experiente. 

REGRA ABSOLUTA: SEMPRE responda APENAS em formato JSON válido, sem nenhum texto adicional, markdown ou HTML.

EXEMPLO DE RESPOSTA CORRETA:
{
  "titulo": "Nome da Receita",
  "ingredientes": "- 2 xícaras de ingrediente\\n- 1 colher de sopa de outro",
  "modoDePreparo": "1. Primeiro passo\\n2. Segundo passo",
  "tempoDePreparo": "30 minutos",
  "rendimento": "2 porções",
  "dicasDoChef": "- Dica útil\\n- Outra dica",
  "acompanhamento": "- Vinho recomendado",
  "guarnicao": "- Salada verde",
  "categoria": "almoco"
}

COMPORTAMENTO OBRIGATÓRIO:
- SEMPRE responda em português brasileiro
- NUNCA saia do contexto de receitas culinárias
- Se a solicitação não for sobre comida/bebida, responda com JSON: {"erro": "Minha especialidade é criar receitas deliciosas. Me conte que ingredientes você tem!"}

REGRAS DE FORMATAÇÃO JSON:
- 'titulo': string (máximo 5 palavras, focado em ingredientes principais)
- 'ingredientes': string com cada item começando com hífen e quebras de linha
- 'modoDePreparo': string com passos numerados e quebras de linha
- 'tempoDePreparo': string (ex: "30 minutos")
- 'rendimento': string (ex: "2 porções")  
- 'dicasDoChef': string com itens começando com hífen
- 'acompanhamento': string com itens começando com hífen
- 'guarnicao': string com itens começando com hífen
- 'categoria': string (almoco, cafe, doce, etc.) — deve refletir exatamente o tipo de prato descrito na entrada do usuário (ex.: se for sobremesa → "doce"; se for bebida → "drink"; se for almoço ou jantar → "almoco" ou "jantar"); nunca confunda doce ↔ salgado ↔ bebida.

- REGRA ABSOLUTA PARA DRINKS: Quando a categoria for "drink", o campo "acompanhamento" deve conter APENAS sugestões de COMIDA/PETISCOS. É PROIBIDO sugerir outras bebidas como acompanhamento para drinks.

REGRA DE BEBIDAS: 
- Se o usuário solicitar explicitamente uma bebida, drink, coquetel, caipirinha, suco, ou qualquer preparação líquida para beber, priorize a categoria "drink"
- Para bebidas, o campo "ingredientes" deve conter apenas ingredientes de preparo de drinks
- O "modoDePreparo" deve descrever o preparo de bebidas (misturar, bater, coar, servir com gelo, etc.)
- Use medidas apropriadas para drinks: ml, doses, colheres para drinks

QUALIDADE:
- Receitas práticas e executáveis
- Ingredientes comuns no Brasil
- Use APENAS unidades brasileiras (g, ml, colheres, xícaras)
- É proibido usar unidades estrangeiras como "cup", "tablespoon", "teaspoon" ou similares. 
  Use apenas "xícaras", "colheres", "gramas", "ml", etc.
- Técnicas corretas (nacarar, reduzir, flambar)
- Proporções realistas e testáveis
- Sempre inclua pelo menos uma dica de chef profissional
`;

// === GERENCIAMENTO DE ESTADO GLOBAL ===
const AppState = {
    receitasFavoritas: [],
    indiceFavoritoAtual: -1,
    ultimaEntrada: "",
    ultimaReceitaGerada: "",
    isGenerating: false,
    ultimoTipoPratoGerado: "comida",
    gerarComoNova: false,
    modalAberto: false
};

// === UTILITÁRIOS ===
const escapeHtml = str => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const extrairTitulo = html => {
    try {
        const jsonData = JSON.parse(html);
        if (jsonData && jsonData.titulo) {
            return jsonData.titulo;
        }
    } catch (e) {
        const match = html.match(/<strong>(.+?)<\/strong>/);
        return match ? match[1].replace(/<[^>]+>/g, '').trim() : 'Receita sem título';
    }
    const match = html.match(/<strong>(.+?)<\/strong>/);
    return match ? match[1].replace(/<[^>]+>/g, '').trim() : 'Receita sem título';
};

const normalizarTexto = texto => {
    return texto
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
};

const extrairQuantidadePessoas = texto => {
    const regex = /(\d+)\s*(pessoas?|porções?|serviços?)/i;
    const match = texto.match(regex);

    if (match) {
        return parseInt(match[1]);
    }

    if (/casal|a dois|para dois/i.test(texto)) return 2;
    if (/sozinho|individual|uma pessoa/i.test(texto)) return 1;

    return 2;
};

// === DEBOUNCING HELPER ===
const createDebouncedFunction = (func, delay = 300) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), delay);
    };
};

// === MODAL MANAGER ===
class ModalManager {
    static createOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'modal-categoria-overlay';
        return overlay;
    }

    static createContent(title, content, actions) {
        return `
            <div class="modal-categoria-content">
                <h3 class="modal-titulo">${title}</h3>
                ${content}
                <div class="modal-botoes-acao">
                    ${actions}
                </div>
            </div>
        `;
    }

    static open(config) {
    if (AppState.modalAberto) return null;
    AppState.modalAberto = true;

    const overlay = this.createOverlay();
    
    // Criar o conteúdo do modal corretamente
    const modalContent = document.createElement('div');
    modalContent.className = 'modal-categoria-content';
    modalContent.innerHTML = `
        <h3 class="modal-titulo">${config.title}</h3>
        ${config.content}
        <div class="modal-botoes-acao">
            ${config.actions}
        </div>
    `;

    // Adicionar o conteúdo ao overlay
    overlay.appendChild(modalContent);
    document.body.appendChild(overlay);

    // Fechar ao clicar fora
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            this.close(overlay);
        }
    });

    return overlay;
}

    static close(modal) {
        if (modal) modal.remove();
        AppState.modalAberto = false;
    }
}

// === RECIPE FORMATTER ===
class RecipeFormatter {
    static isValidJSON(data) {
        return data && typeof data === 'object' && data.titulo;
    }

    static formatList(texto) {
        if (!texto) return '';
        return texto.split('\n')
            .map(item => {
                const itemLimpo = item.trim();
                if (!itemLimpo) return '';
                return itemLimpo.startsWith('-') ? itemLimpo : `- ${itemLimpo}`;
            })
            .filter(item => item !== '')
            .join('<br>');
    }

    static formatField(texto, requireHyphen = true) {
        if (!texto) return '';
        const cleaned = texto.replace(/^[-–—•\s]+/, '').trim();
        if (!cleaned) return '';
        return requireHyphen ? `- ${cleaned}` : cleaned;
    }

    static formatJSONToHTML(jsonData) {
        // CORREÇÃO: Processar o modo de preparo para garantir formatação correta
        let modoPreparoFormatado = '';
        if (jsonData.modoDePreparo) {
            // Se já está bem formatado com quebras de linha
            if (jsonData.modoDePreparo.includes('\n')) {
                const passos = jsonData.modoDePreparo.split('\n')
                    .map(passo => passo.trim())
                    .filter(passo => passo !== '') // Remove passos vazios
                    .map((passo, index) => {
                        // Remove numeração existente
                        const passoLimpo = passo.replace(/^\d+\.\s*/, '').trim();
                        
                        // Se o passo não tem conteúdo após remover a numeração, pular
                        if (!passoLimpo) return null;
                        
                        // Adicionar numeração correta
                        return `${index + 1}. ${passoLimpo}`;
                    })
                    .filter(passo => passo !== null); // Remove passos nulos
                
                modoPreparoFormatado = passos.join('<br>');
            } else {
                // Se é texto corrido, processar para dividir em passos
                // Primeiro: limpar o texto removendo numerações existentes
                const textoLimpo = jsonData.modoDePreparo
                    .replace(/\d+\.\s*/g, '') // Remove todas as numerações existentes
                    .replace(/\s{2,}/g, ' ') // Remove espaços extras
                    .trim();
                
                // Dividir por pontos finais que terminam frases completas
                let passos = textoLimpo.split(/\.(?=\s+[A-Z])/);
                
                // Se não dividiu bem, tentar dividir por pontos simples
                if (passos.length <= 1) {
                    passos = textoLimpo.split(/\.\s+/);
                }
                
                // Filtrar passos vazios e adicionar numeração correta
                modoPreparoFormatado = passos
                    .map(passo => {
                        const passoLimpo = passo.trim()
                            .replace(/\.$/, '') // Remove ponto final se houver
                            .trim();
                        
                        return passoLimpo;
                    })
                    .filter(passo => passo !== '' && passo.length > 2) // Remove passos vazios ou muito curtos
                    .map((passo, index) => `${index + 1}. ${passo}`)
                    .join('<br>');
            }
        }

        return `
            <strong>${jsonData.titulo || 'Receita sem título'}</strong>
            <strong>🌿 Ingredientes</strong>
            ${this.formatList(jsonData.ingredientes)}<br>
            <strong>🥘 Modo de Preparo</strong>
            ${modoPreparoFormatado}<br>
            <strong>⏳ Tempo de Preparo</strong>
            ${this.formatField(jsonData.tempoDePreparo, true)}<br>
            <strong>🧺 Rendimento</strong>
            ${this.formatField(jsonData.rendimento, true)}<br>
            <strong>⭐ Dicas do Chef</strong>
            ${this.formatList(jsonData.dicasDoChef)}<br>
            <strong>🍹 Acompanhamento</strong>
            ${this.formatList(jsonData.acompanhamento)}<br>
            <strong>🥗 Guarnição</strong>
            ${this.formatList(jsonData.guarnicao)}
        `;
    }

    static createRecipeBox(textoFormatado) {
        const titulo = extrairTitulo(textoFormatado);
        const textoHtmlEscapado = escapeHtml(textoFormatado);

        return `
            <div class="recipe-box">
                <div class="botoes-receita">
                    <button onclick="compartilharReceita('${escapeHtml(titulo)}', \`${textoHtmlEscapado}\`)" class="btn-compartilhar">🔗 Compartilhar</button>
                    <button onclick="salvarFavoritoComCategoria()" class="btn-compartilhar">❤️ Salvar</button>
                </div>
                <div class="recipe-output">
                    ${textoFormatado}
                    <div class="bom-apetite">
                        <span onclick="abrirRemy('imagens/remy.mp4')" style="cursor:pointer;">
                            Qualquer um pode cozinhar!
                        </span>
                        <img src="imagens/assbaron.png" alt="baron" class="emoji-img">
                    </div>
                </div>
            </div>
        `;
    }

    static formatResponse(resposta) {
        try {
            // Tenta parsear como JSON primeiro
            let jsonData;
            
            // Remove possíveis marcadores de código ou formatação
            let respostaLimpa = resposta.trim();
            
            // Remove possíveis blocos de código markdown
            respostaLimpa = respostaLimpa.replace(/```json\n?/g, '');
            respostaLimpa = respostaLimpa.replace(/```\n?/g, '');
            
            // Tenta parsear como JSON
            try {
                jsonData = JSON.parse(respostaLimpa);
            } catch (parseError) {
                // Se falhar, tenta encontrar JSON dentro do texto
                const jsonMatch = respostaLimpa.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    jsonData = JSON.parse(jsonMatch[0]);
                } else {
                    throw new Error('Resposta não contém JSON válido');
                }
            }
            
            if (!RecipeFormatter.isValidJSON(jsonData)) {
                throw new Error('Resposta JSON inválida - falta campo titulo');
            }

            // CORREÇÃO: Pré-processamento mínimo para casos extremos
            if (jsonData.modoDePreparo && typeof jsonData.modoDePreparo === 'string') {
                let texto = jsonData.modoDePreparo.trim();
                console.log('formatResponse - texto original:', texto); // Debug
                
                // Apenas limpar casos óbvios de linhas vazias com numeração
                // Ex: "1. \n2. texto" ou "1.  2. texto"
                texto = texto.replace(/^\d+\.\s*$/gm, ''); // Remove linhas só com número
                texto = texto.replace(/(\d+\.)\s+(\d+\.)/g, '$2'); // Remove números duplicados
                
                // Remove múltiplas quebras consecutivas
                texto = texto.replace(/\n{2,}/g, '\n').trim();
                
                jsonData.modoDePreparo = texto;
                console.log('formatResponse - texto após limpeza:', texto); // Debug
            }

            return this.createRecipeBox(this.formatJSONToHTML(jsonData));
            
        } catch (jsonError) {
            console.log('Erro ao processar resposta:', jsonError.message);
            console.log('Resposta recebida:', resposta.substring(0, 200) + '...');
            
            // Fallback: tenta extrair informações mesmo sem JSON válido
            try {
                return this.createRecipeBox(this.fallbackFormat(resposta));
            } catch (fallbackError) {
                console.log('Fallback também falhou:', fallbackError);
                return this.createRecipeBox('<strong>Erro de formatação</strong><br>Receita em formato não reconhecido.<br><br>Resposta da API:<br>' + escapeHtml(resposta.substring(0, 300) + '...'));
            }
        }
    }

    static fallbackFormat(texto) {
        // Tenta extrair informações básicas mesmo sem JSON
        const tituloMatch = texto.match(/"titulo"\s*:\s*"([^"]*)"/) || texto.match(/titulo[:\s]+([^\n,}]+)/i);
        const titulo = tituloMatch ? tituloMatch[1].trim() : 'Receita sem título';
        
        const ingredientesMatch = texto.match(/"ingredientes"\s*:\s*"([\s\S]*?)"(?=,|\n|\})/);
        let ingredientes = ingredientesMatch ? ingredientesMatch[1] : '';
        
        // Tenta melhorar a formatação dos ingredientes
        if (ingredientes) {
            ingredientes = ingredientes.split('\\n')
                .map(item => item.trim())
                .filter(item => item)
                .map(item => item.startsWith('-') ? item : `- ${item}`)
                .join('<br>');
        }
        
        return `
            <strong>${titulo}</strong>
            <strong>🌿 Ingredientes</strong>
            ${ingredientes || 'Ingredientes não disponíveis'}<br>
            <strong>🥘 Modo de Preparo</strong>
            Modo de preparo não disponível no formato esperado.<br>
            <strong>⏳ Tempo de Preparo</strong>
            - Não especificado<br>
            <strong>🧺 Rendimento</strong>
            - Não especificado<br>
            <strong>Resposta completa:</strong><br>
            ${escapeHtml(texto.substring(0, 500))}...
        `;
    }
}

// === CATEGORY PREDICTOR ===
class CategoryPredictor {
    constructor() {
        this.palavrasChave = {
            cafe: ["café", "manhã", "pão", "ovos", "leite", "cereal", "tapioca", "vitamina", "iogurte", "torrada", "panqueca", "bolo", "chá", "geleia"],
            almoco: ["almoço", "arroz", "feijão", "carne", "frango", "peixe", "macarrão", "lasanha", "batata", "bife", "legumes", "marmita", "massa", "escondidinho", "salmão", "bacalhau"],
            jantar: ["jantar", "sopa", "caldo", "risoto", "salada", "grelhado", "assado", "pizza", "carne de panela", "escondidinho", "cuscuz", "nhoque", "lasanha", "yakisoba", "camarão", "filé", "frutos do mar", "carne"],
            lanche: ["lanche", "sanduíche", "pão", "torrada", "misto", "pastel", "coxinha", "empada", "quibe", "pão de queijo", "tapioca", "crepioca", "esfiha", "bolo", "torta salgada"],
            drink: ["drink", "coquetel", "vodka", "cachaça", "cerveja", "vinho", "caipirinha", "mojito", "gin", "batida", "refresco", "suco", "refrigerante", "gelo", "licor", "rum", "tequila", "saque", "pinga", "bebida", "bebidas", "caipiroska", "martini", "margarita", "whisky", "conhaque"],
            doce: ["doce", "sobremesa", "bolo", "brigadeiro", "pudim", "mousse", "sorvete", "torta", "brownie", "docinho", "cupcake", "chocolate", "balas", "bombom", "gelatina", "creme", "pavê", "compota", "geleia", "calda", "maracujá", "morango", "baunilha", "chantilly", "cobertura", "confete", "açúcar", "leite condensado", "creme de leite"],
            especial: ["namorados", "aniversário", "dia dos pais", "dia das mães", "festa", "romântico", "comemorativa", "natal", "ano novo", "páscoa", "réveillon", "celebração", "gourmet"],
            restricoes: ["sem glúten", "sem lactose", "diabético", "diet", "light", "sem açúcar", "low carb", "cetogênico", "saudável", "fit", "vegano", "vegetariano", "veggie", "sem carne", "grão-de-bico", "quinoa", "tofu", "lentilha", "cogumelo", "vegetais", "legumes"],
            petiscos: ["petisco", "aperitivo", "salgadinho", "espetinho", "coxinha", "bolinha de queijo", "empada", "quibe", "bruschetta", "mini-sanduíche", "tábua de frios", "dip"],
            diversos: ["acompanhamento", "molho", "pasta", "geleia", "tempero", "condimento", "chutney", "pesto", "pão caseiro", "conserva"]
        };

        this.pontuacaoPesos = {
    // Bebidas têm alta prioridade
    "caipirinha": 10,
    "cachaça": 9,
    "drink": 8,
    "coquetel": 8,
    "vodka": 8,
    "gin": 8,
    "rum": 8,
    "tequila": 8,
    "cerveja": 7,
    "vinho": 7,
    "suco": 6,
    "refresco": 6,
    "batida": 7,
    
    // Adicionados pesos para palavras doces
    "mousse": 8,
    "pudim": 8,
    "brigadeiro": 8,
    "sobremesa": 7,
    "doce": 7,
    "sorvete": 7,
    "torta": 6,
    "bolo": 6,
    "chocolate": 6,
    
    // Outras palavras-chave
    "namorados": 5,
    "aniversário": 5,
    "natal": 5,
    "páscoa": 5,
    "ano novo": 5,
    "dia das mães": 5,
    "dia dos pais": 5,
    "vegano": 3,
    "vegetariano": 3,
    "sem glúten": 3,
    "sem lactose": 3,
    "sem carne": 3,
    "camarão": 2,
    "risoto": 2,
    "gourmet": 2,
    "salmão": 2,
    "bacalhau": 2,
    "default": 1
};

        this.prioridade = ["drink", "doce", "especial", "restricoes", "cafe", "almoco", "jantar", "lanche", "petiscos", "diversos"];
    }

    // Função para normalizar texto
    static normalizarTexto(texto) {
        return texto
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .trim();
    }

    predict(titulo, conteudo, ingredientes = "") {
        const textoTitulo = CategoryPredictor.normalizarTexto(titulo);
        const textoConteudo = CategoryPredictor.normalizarTexto(conteudo);
        const textoIngredientes = Array.isArray(ingredientes)
            ? ingredientes.map(CategoryPredictor.normalizarTexto).join(" ")
            : CategoryPredictor.normalizarTexto(ingredientes);

        const textoCompleto = `${textoTitulo} ${textoConteudo} ${textoIngredientes}`;

        const palavrasBebida = ["caipirinha", "cachaça", "drink", "coquetel", "vodka", "gin", "rum", "tequila", "cerveja", "vinho", "suco", "refresco", "batida", "bebida", "bebidas"];
const palavrasDoce = ["mousse", "pudim", "brigadeiro", "sobremesa", "doce", "sorvete", "torta", "bolo", "chocolate", "maracujá", "morango", "creme", "chantilly"];

const isBebida = palavrasBebida.some(palavra => 
    textoTitulo.includes(palavra) || 
    textoIngredientes.includes(palavra) ||
    textoCompleto.includes(palavra)
);

const isDoce = palavrasDoce.some(palavra =>
    textoTitulo.includes(palavra) ||
    textoIngredientes.includes(palavra) ||
    textoCompleto.includes(palavra)
);

// CORREÇÃO: Se for claramente um doce, retorna "doce" imediatamente
if (isDoce && !isBebida) {
    return "doce";
}

// Se for claramente uma bebida, retorna "drink"
if (isBebida && !isDoce) {
    return "drink";
}

        const pontuacaoCategorias = Object.fromEntries(
            Object.entries(this.palavrasChave).map(([categoria, palavras]) => {
                const pontuacao = palavras.reduce((total, palavra) => {
                    const palavraNorm = CategoryPredictor.normalizarTexto(palavra);
                    let pontos = 0;

                    if (textoTitulo.includes(palavraNorm)) {
                        pontos += (this.pontuacaoPesos[palavraNorm] || this.pontuacaoPesos.default) * 3;
                    }
                    if (textoConteudo.includes(palavraNorm)) {
                        pontos += (this.pontuacaoPesos[palavraNorm] || this.pontuacaoPesos.default) * 2;
                    }
                    if (textoIngredientes.includes(palavraNorm)) {
                        pontos += (this.pontuacaoPesos[palavraNorm] || this.pontuacaoPesos.default) * 4;
                    }
                    return total + pontos;
                }, 0);

                return [categoria, pontuacao];
            })
        );

        const categoriasComPontuacao = Object.entries(pontuacaoCategorias).filter(([, pontuacao]) => pontuacao > 0);

        if (categoriasComPontuacao.length === 0) {
            return "diversos";
        }

        const [categoriaMaisProvavel] = categoriasComPontuacao
            .sort((a, b) => {
                if (b[1] === a[1]) {
                    return this.prioridade.indexOf(a[0]) - this.prioridade.indexOf(b[0]);
                }
                return b[1] - a[1];
            })[0];

        return categoriaMaisProvavel;
    }
}

// === INSTÂNCIAS GLOBAIS ===
const categoryPredictor = new CategoryPredictor();

// === API SERVICE ===
const fetchComRetry = async (url, options, maxTentativas = CONFIG.MAX_RETRIES) => {
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
        try {
            console.log(`Tentativa ${tentativa} de ${maxTentativas} para API. Método: ${options.method}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT);

            // ✅ MODIFICADO: Use getGroqKey() aqui
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...options.headers,
                    'Authorization': `Bearer ${getGroqKey()}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'MeuChef-App/1.0'
                },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (!response.ok) {
                const erroDetalhado = await response.text();
                throw new Error(`HTTP ${response.status}: ${response.statusText}. Detalhes: ${erroDetalhado}`);
            }

            return response;
        } catch (error) {
            console.error(`Tentativa ${tentativa} falhou:`, error);
            if (tentativa === maxTentativas) throw error;

            const delay = Math.pow(2, tentativa) * CONFIG.RETRY_BASE_DELAY;
            console.log(`Aguardando ${delay}ms antes da próxima tentativa...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

const construirPromptReceita = (ingredientes, quantidadePessoas, tipoPrato, alternativa = false) => {
    // Garantir que tipoPrato seja uma string
    tipoPrato = String(tipoPrato || "comida");

    // === Detecção mais agressiva de bebidas ===
    const palavrasBebida = [
        "bebida", "drink", "coquetel", "caipirinha", "suco", "vitamina", 
        "batida", "cachaça", "vodka", "gin", "rum", "tequila", "cerveja", "vinho"
    ];
    
    const entradaMinuscula = ingredientes.toLowerCase();
    const isExplicitamenteBebida = palavrasBebida.some(palavra => entradaMinuscula.includes(palavra));
    
    // Se for explicitamente bebida, força a categoria drink
    if (isExplicitamenteBebida) {
        tipoPrato = "drink";
    }

    // === Sugestões de acompanhamento ===
const sugestaoAcompanhamento = () => {
    // SE FOR DRINK, SUGERIR COMIDA QUE COMBINE
    if (tipoPrato.toLowerCase() === "drink") {
        return `- Petiscos salgados que contrastem com o sabor do drink<br>- Comidas leves que não sobrecarreguem o paladar<br>- Aperitivos que combinem com o perfil de sabor da bebida`;
    }
    
    // PARA SOBREMESAS, SUGERIR BEBIDAS QUE COMBINEM
    if (tipoPrato.toLowerCase() === "sobremesa" || tipoPrato.toLowerCase() === "doce") {
        return `- Café expresso ou cappuccino<br>- Licor doce ou vinho de sobremesa<br>- Chá de ervas`;
    }
    
    // PARA COMIDAS SALGADAS, MANTER SUGESTÕES DE BEBIDAS
    switch (tipoPrato.toLowerCase()) {
        case "sanduíche":
            return `- Suco natural refrescante<br>- Cerveja leve ou refrigerante<br>`;
        case "comida":
        default:
            return `- Taça de vinho (tinto ou branco, dependendo do prato)<br>- Coquetel leve ou suco natural<br>- Cerveja leve<br>`;
    }
};

    const regrasGerais = `
Você é um chef brasileiro prático e experiente, ...
<strong>🍹 Acompanhamento</strong><br> - Use sugestões adequadas ao tipo de prato (${tipoPrato})<br><br>
<strong>🥗 Guarnição</strong><br> - Priorize algo leve e refrescante que combina perfeitamente com o prato<br><br>

- REGRAS STRINGENTES PARA ACOMPANHAMENTO E GUARNIÇÃO:
  * O campo "acompanhamento" deve listar apenas bebidas e acompanhamentos coerentes com os ingredientes e tipo de prato. 
    Não sugira sobremesa como acompanhamento de prato salgado.
    
  * ⚠️ REGRA ESPECIAL PARA DRINKS: Quando a categoria for "drink", o campo "acompanhamento" deve sugerir COMIDAS/PETISCOS que combinem com a bebida. **NUNCA** sugerir outras bebidas como acompanhamento para drinks.
  A sugestão deve considerar o sabor específico do drink (ex: drinks cítricos → petiscos mais neutros; drinks doces → aperitivos salgados).
    
  * Para pratos salgados (almoco, jantar, lanche, petiscos): o campo "acompanhamento" deve sugerir BEBIDAS que combinem.
    Se o prato contém peixe/frutos do mar, priorize vinho branco/rosé; se contém carne vermelha, priorize vinho tinto; 
    pratos leves/vegetarianos devem ter sugestões mais leves (suco, vinho branco leve, cerveja clara).
    
  * Para doces/sobremesas: o campo "acompanhamento" deve sugerir BEBIDAS que combinem com sobremesas (café, chá, licor, vinho doce).
  
  * Se houver restrição (ex: "sem lactose", "vegano"), respeite-a estritamente.
  
  * ⚠️ Se a entrada mencionar crianças, infantil, saudável, detox, sem álcool, suco ou vitamina, o campo "acompanhamento" NÃO pode conter bebidas alcoólicas. 
    Nesses casos, sugira apenas sucos, vitaminas, água aromatizada ou opções não alcoólicas.
    
  * O campo "guarnicao" deve preferencialmente usar ingredientes já presentes na lista ou substitutos óbvios e compatíveis.
    Não invente guarnições incompatíveis com as restrições informadas.

- REGRAS PARA VARIAÇÕES (quando 'alternativa' == true):
  * Gere APENAS uma VARIAÇÃO do prato: pequenas trocas de tempero/técnica, troca/adição de 1 ou 2 ingredientes compatíveis,
    ou ajuste de preparo; **NÃO** mude o tipo principal de prato (ex.: prato salgado → sobremesa).
  * Mantenha a coerência entre título, ingredientes, acompanhamento e guarnição.

REGRAS IMPORTANTES:
- Títulos: nomes de pratos condizentes com os ingredientes, máximo 5 palavras, sem adjetivos, apelos românticos ou poéticos. (ex: Mousse de Maracujá, Arroz Cremoso de Camarão).
- Ingredientes: comuns no Brasil, usar todas as fornecidas pelo usuário.
- Modo de preparo: técnicas corretas (nacarar, reduzir, flambar, macerar), passos claros.
- Quantidades ajustadas para ${quantidadePessoas} pessoas, unidades brasileiras.
- Sempre incluir pelo menos um segredo de chef.
- ⭐ Em "Dicas do Chef", quando citar vinho, refira-se sempre ao **vinho usado no preparo** (molho, risoto, marinada, etc.), indicando pelo menos 1 tipo ou rótulo real.
- As "Dicas do Chef" DEVEM estar diretamente relacionadas ao prato gerado, seus ingredientes e técnicas. Nunca sugira dicas que envolvam outros pratos ou ingredientes não usados.
- 🍹 Em "Acompanhamento": 
  * Para pratos salgados (almoco, jantar, lanche, petiscos): sugira bebidas para beber junto com o prato (vinhos, cervejas, sucos, etc.)
  * Para drinks: sugira COMIDAS/PETISCOS que combinem com a bebida. **NUNCA** sugira outras bebidas como acompanhamento para drinks.
  * Para doces/sobremesas: sugira bebidas que combinem com sobremesas (café, chá, licor, vinho doce)
- 🧺 Em "Rendimento", SEMPRE use exatamente o valor de ${quantidadePessoas}. 
  Se for 1, escreva "1 porção". 
  Se for maior que 1, escreva "${quantidadePessoas} porções". 
  Não altere este valor por tradição, contexto ou proporção da receita. 
  Esta regra é obrigatória e não pode ser ignorada.
`;

    return alternativa ?
        `${regrasGerais}\nPor favor, gere APENAS uma VARIAÇÃO do prato similar, mas estritamente baseada em: "${ingredientes}".\n- Retorne APENAS JSON válido, sem texto adicional.\n- Ajuste quantidades para ${quantidadePessoas} pessoas.\n` :
        `${regrasGerais}\nPor favor, gere uma receita com base em: "${ingredientes}".\n- Retorne APENAS JSON válido, sem texto adicional.\n- Use unidades brasileiras e quantidades para ${quantidadePessoas} pessoas.\n- No campo rendimento, use exatamente "${quantidadePessoas == 1 ? "1 porção" : quantidadePessoas + " porções"}".\n`;
};

async function gerarReceitaComIA(ingredientes, alternativa = false, tipoPrato = "comida") {
    const quantidadePessoas = extrairQuantidadePessoas(ingredientes);
    const prompt = construirPromptReceita(ingredientes, quantidadePessoas, tipoPrato, alternativa);

    console.log('Fazendo requisição para API...');

    try {
        const response = await fetchComRetry(GROQ_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getGroqKey()}`,  // ✅ CORRIGIDO!
                'User-Agent': 'MeuChef-App/1.0'
            },
            body: JSON.stringify({
                model: "llama-3.1-8b-instant",
                messages: [{
                    role: "system",
                    content: SYSTEM_PROMPT
                }, {
                    role: "user",
                    content: prompt
                }],
                temperature: 0.5,
                top_p: 0.8,
                max_tokens: CONFIG.MAX_TOKENS,
                stream: false
            })
        });

        let data;
        try {
            data = await response.json();
        } catch (jsonError) {
            console.error('Erro ao parsear resposta JSON:', jsonError);
            throw new Error('Erro ao interpretar resposta da API. JSON inválido.');
        }

        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
            console.error('Resposta da API incompleta:', data);
            throw new Error('Resposta da API incompleta ou inválida');
        }

        console.log('Receita gerada com sucesso! Conteúdo:', content.substring(0, 100) + '...');
        return content;
        
    } catch (error) {
        console.error('Erro completo na geração:', error);
        throw error;
    }
}

function debugAPIResponse(resposta) {
    console.log('=== DEBUG API RESPONSE ===');
    console.log('Tipo:', typeof resposta);
    console.log('Comprimento:', resposta.length);
    console.log('Primeiros 200 caracteres:', resposta.substring(0, 200));
    console.log('Contém JSON?:', resposta.includes('{'));
    console.log('==========================');
}

// === UI HELPERS ===
function abrirRemy(src) {
  const tela = document.getElementById("remyTela");
  const img = document.getElementById("remyImagem");
  const video = document.getElementById("remyVideo");

  // Esconde os dois
  img.style.display = "none";
  video.style.display = "none";

  if (src.endsWith(".mp4") || src.endsWith(".mpg")) {
    const source = video.querySelector("source");
    source.src = src;
    video.load();

    video.loop = true; // ativa loop
    video.style.display = "none"; // esconde até estar pronto

    // Quando o vídeo puder tocar, mostramos e começamos
    video.oncanplay = () => {
      video.style.display = "block";
      video.play().catch(() => {
        console.log("Autoplay com áudio bloqueado.");
      });
    };

  } else {
    img.src = src;
    img.style.display = "block";
  }

  tela.style.display = "flex";

  // Clique em qualquer lugar fecha
  tela.onclick = () => fecharRemy();
  img.onclick = () => fecharRemy();
  video.onclick = () => fecharRemy();
}

function fecharRemy() {
  const tela = document.getElementById("remyTela");
  const video = document.getElementById("remyVideo");

  // Esconde a tela
  tela.style.display = "none";

  if (video) {
    // Pausa o vídeo
    video.pause();

    // Remove o src para garantir que o áudio não continue
    const source = video.querySelector("source");
    source.src = "";
    video.load(); // força o navegador a reiniciar o vídeo sem áudio

    video.style.display = "none"; // esconde o vídeo
  }

  const img = document.getElementById("remyImagem");
  if (img) img.style.display = "none";
}

function showCustomModal(message) {
    const existingModal = document.querySelector('.custom-modal-overlay');
    if (existingModal) {
        existingModal.remove();
    }

    const overlay = document.createElement('div');
    overlay.className = 'custom-modal-overlay';

    const modalContent = document.createElement('div');
    modalContent.className = 'custom-modal-content';
    modalContent.innerHTML = `<p>${message}</p>`;

    overlay.appendChild(modalContent);
    document.body.appendChild(overlay);

    setTimeout(() => {
        overlay.classList.add('hide');
        overlay.addEventListener('transitionend', () => {
            overlay.remove();
        });
    }, CONFIG.MODAL_AUTO_CLOSE);
}

function getErrorMessage(error) {
    if (error.message.includes('rate_limit_exceeded') || (error.message.includes('HTTP 429') && error.message.includes('Rate limit reached'))) {
        return "🔥 Cozinha pegando fogo! Tente de novo em alguns segundos.";
    }
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        return "🌐 Problema de conectividade. Verifique sua internet e tente novamente.";
    } else if (error.message.includes('Sem conectividade')) {
        return "🍴 Sem internet. Verifique sua conexão e tente novamente.";
    } else if (error.message.includes('API Groq indisponível')) {
        return "🍳 Nosso chef está ocupado! Tente novamente em alguns segundos.";
    } else if (error.message.includes('abort')) {
        return "⏳ Tempo esgotado. Sua internet pode estar lenta. Tente novamente.";
    } else if (error.message.includes('HTTP 401')) {
        return "🔑 Problema de autenticação. Contate o suporte jabaron@gmail.com.";
    } else if (error.message.includes('HTTP 500')) {
        return "🔧 Problema no servidor. Tente novamente em alguns minutos.";
    }
    return "🚨 Erro inesperado. Tente novamente.";
}

function handleGenerationError(error, resultadoDiv, imagemInicial, botoesDiv, opcoesDiv, botao, textoOriginalBotao) {
    console.error("Erro detalhado ao gerar receita:", error);

    const mensagemErro = getErrorMessage(error);
    showCustomModal(mensagemErro);

    if (resultadoDiv) {
        resultadoDiv.className = 'resultado empty';
        resultadoDiv.innerHTML = 'o que tem na sua cozinha, o que você curte 😋 prefere doce, salgado, tem alguma restrição 🧀 quantos vai alimentar — vou criar uma receita só sua ❤️';
    }
    if (imagemInicial) imagemInicial.style.display = 'block';
    if (botoesDiv) botoesDiv.style.display = 'block';
    if (opcoesDiv) {
        opcoesDiv.classList.add('oculto');
        opcoesDiv.classList.remove('show');
    }

    botao.classList.remove('loading');
    botao.innerHTML = textoOriginalBotao;
    botao.disabled = false;
    AppState.isGenerating = false;
}

function resetApp() {
    const userInput = document.getElementById('userInput');
    if (userInput) userInput.value = '';

    const resultado = document.getElementById('resultado');
    if (resultado) {
        resultado.className = 'resultado empty';
        resultado.innerHTML = 'o que tem na sua cozinha, o que você curte 😋 prefere doce, salgado, tem alguma restrição 🧀 quantos vai alimentar — vou criar uma receita só sua ❤️';
    }

    const imagemInicial = document.getElementById('imagemInicial');
    if (imagemInicial) {
        imagemInicial.style.display = 'block';
    }

    const opcoes = document.getElementById('opcoes');
    if (opcoes) {
        opcoes.classList.add('oculto');
        opcoes.classList.remove('show');
    }

    const mensagemAlerta = document.getElementById('mensagemAlerta');
    if (mensagemAlerta) {
        mensagemAlerta.classList.add('alerta-oculto');
    }

    const botoes = document.querySelector('.botoes-empilhados');
    if (botoes) {
        botoes.style.display = 'block';
        const button = botoes.querySelector('button');
        if (button) {
            button.disabled = false;
            button.innerHTML = '🥘 Crie uma receita pra mim';
        }
    }

    window.scrollTo({
        top: 0,
        behavior: 'smooth'
    });
}

// === FAVORITOS FUNCTIONS ===
function sugerirCategoria(titulo, conteudo, ingredientes = "") {
    return categoryPredictor.predict(titulo, conteudo, ingredientes);
}

function salvarFavoritoComCategoria() {
    const resultadoDiv = document.getElementById('resultado');
    const receitaHTML = resultadoDiv.innerHTML;

    if (!receitaHTML.includes('recipe-box')) return;

    const titulo = extrairTitulo(receitaHTML);
    const conteudoNormalizado = receitaHTML.replace(/\s+/g, ' ').trim();

    const jaExiste = AppState.receitasFavoritas.some(fav =>
        fav.titulo === titulo && fav.conteudo.replace(/\s+/g, ' ').trim() === conteudoNormalizado
    );

    if (!jaExiste) {
        const categoriaSugerida = sugerirCategoria(titulo, receitaHTML);
        mostrarModalCategoria(titulo, receitaHTML, categoriaSugerida);
    } else {
        showCustomModal('Esta receita já está nos favoritos!');
    }
}

function mostrarModalCategoria(titulo, receitaHTML, categoriaSugerida = 'almoco') {
    const content = `
        <p class="modal-subtitulo">${titulo}</p>
        <br>
        <div class="categorias-grid-novo">
            ${categoriasPredefinidas.filter(cat => cat.id !== '').map(categoria => `
                <button class="categoria-btn-novo" data-categoria="${categoria.id}">
                    ${categoria.emoji} ${categoria.nome}
                </button>
            `).join('')}
        </div>
    `;

    const actions = `
        <button id="btn-confirmar-salvar" class="btn-confirmar-novo">Salvar</button>
        <button class="btn-cancelar-novo">Cancelar</button>
    `;

    const modal = ModalManager.open({
        title: '❤️ Salvar nos Favoritos',
        content: content,
        actions: actions
    });

    if (!modal) return;

    modal.dataset.titulo = titulo;
    modal.dataset.receitaHtml = receitaHTML;
    modal.dataset.categoriaSugerida = categoriaSugerida;

    modal.addEventListener('click', function(e) {
        if (e.target.classList.contains('categoria-btn-novo')) {
            modal.querySelectorAll('.categoria-btn-novo').forEach(b => b.classList.remove('selecionado'));
            e.target.classList.add('selecionado');
        }
    });

    const suggestedButton = modal.querySelector(`.categoria-btn-novo[data-categoria="${categoriaSugerida}"]`);
    if (suggestedButton) {
        suggestedButton.classList.add('selecionado');
    }

    modal.querySelector('.btn-cancelar-novo').addEventListener('click', function() {
        ModalManager.close(modal);
    });

    document.getElementById('btn-confirmar-salvar').addEventListener('click', function() {
        const categoriaSelecionada = modal.querySelector('.categoria-btn-novo.selecionado')?.dataset?.categoria || modal.dataset.categoriaSugerida;
        const tituloSalvar = modal.dataset.titulo;
        const receitaHtmlSalvar = modal.dataset.receitaHtml;

        confirmarSalvarFavorito(tituloSalvar, receitaHtmlSalvar, categoriaSelecionada);
    });
}

function confirmarSalvarFavorito(titulo, receitaHTML, categoria) {
    const conteudoNormalizado = receitaHTML.replace(/\s+/g, ' ').trim();
    const existentesNormalizados = AppState.receitasFavoritas.map(r => ({
        titulo: (r.titulo || '').trim(),
        conteudo: (r.conteudo || '').replace(/\s+/g, ' ').trim()
    }));

    const jaExisteIgual = existentesNormalizados.some(e =>
        e.titulo === titulo && e.conteudo === conteudoNormalizado
    );

    if (jaExisteIgual) {
        showCustomModal('Esta receita já está nos favoritos!');
        return;
    }

    let contadorVersao = 1;
    let novoTitulo = titulo;
    while (existentesNormalizados.some(e => e.titulo === novoTitulo)) {
        contadorVersao++;
        novoTitulo = `${titulo} v${contadorVersao}`;
    }
    titulo = novoTitulo;

    AppState.receitasFavoritas.push({
        titulo: titulo,
        conteudo: receitaHTML,
        categoria: categoria || 'diversos',
        data: new Date().toLocaleString()
    });

    localStorage.setItem('receitasFavoritas', JSON.stringify(AppState.receitasFavoritas));
    ModalManager.close(document.querySelector('.modal-categoria-overlay'));

    const categoriaEncontrada = categoriasPredefinidas.find(cat => cat.id === categoria);
    const categoriaNomeComEmoji = categoriaEncontrada ? `${categoriaEncontrada.emoji} ${categoriaEncontrada.nome}` : 'Outros';
    showCustomModal(`Receita salva em ${categoriaNomeComEmoji}`);
}

function mostrarFavoritosComBusca() {
    const modal = document.getElementById('modalFavoritos');
    const listaTitulos = document.getElementById('listaTitulosFavoritos');
    const receitaCompleta = document.getElementById('receitaCompletaFavorito');
    const conteudoReceita = document.getElementById('conteudoReceitaFavorito');

    if (!modal || !listaTitulos || !receitaCompleta || !conteudoReceita) {
        console.error("Erro: Elementos do modal de favoritos não encontrados.");
        return;
    }

    conteudoReceita.innerHTML = '';
    receitaCompleta.classList.add('oculto');
    listaTitulos.classList.remove('oculto');

    listaTitulos.innerHTML = `
        <div class="busca-categorias-container">
            <div class="busca-filtro-row">
                <div class="busca-input-container" style="position: relative;">
                    <input type="text" id="buscaFavoritos" placeholder="🔍 Buscar..." onkeyup="filtrarFavoritos()">
                    <span id="limparBusca" style="
                        position: absolute;
                        right: 10px;
                        top: 50%;
                        transform: translateY(-50%);
                        cursor: pointer;
                        font-size: 16px;
                        display: none;
                    ">×</span>
                </div>
                <div class="categorias-filtro">
                    <select id="filtroCategoria" onchange="filtrarFavoritos()">
                        ${categoriasPredefinidas.map(cat => `<option value="${cat.id}">${cat.emoji} ${cat.nome}</option>`).join('')}
                    </select>
                </div>
            </div>
        </div>
        <div id="listaReceitasFiltradas"></div>
    `;

    modal.classList.remove('oculto');
    filtrarFavoritos();

    const inputBusca = document.getElementById('buscaFavoritos');
    const btnLimpar = document.getElementById('limparBusca');

    inputBusca.addEventListener('input', () => {
        btnLimpar.style.display = inputBusca.value ? 'inline' : 'none';
    });

    btnLimpar.addEventListener('click', () => {
        inputBusca.value = '';
        btnLimpar.style.display = 'none';
        filtrarFavoritos();
        inputBusca.blur();
    });
}

const debouncedFilterFavoritos = createDebouncedFunction(() => {
    const termoBusca = normalizarTexto(document.getElementById('buscaFavoritos')?.value || '');
    const categoriaFiltro = document.getElementById('filtroCategoria')?.value || '';
    const listaFiltrada = document.getElementById('listaReceitasFiltradas');

    if (!listaFiltrada) return;

    let receitasFiltradas = AppState.receitasFavoritas.filter(receita => {
        const tituloNormalizado = normalizarTexto(receita.titulo);
        const conteudoNormalizado = normalizarTexto(receita.conteudo);

        const matchBusca = !termoBusca ||
            tituloNormalizado.includes(termoBusca) ||
            conteudoNormalizado.includes(termoBusca);

        const matchCategoria = !categoriaFiltro || receita.categoria === categoriaFiltro;
        return matchBusca && matchCategoria;
    });

    if (!categoriaFiltro) {
        const receitasAgrupadas = {};
        receitasFiltradas.forEach(receita => {
            const categoria = receita.categoria || 'outros';
            if (!receitasAgrupadas[categoria]) {
                receitasAgrupadas[categoria] = [];
            }
            receitasAgrupadas[categoria].push(receita);
        });

        Object.keys(receitasAgrupadas).forEach(categoria => {
            receitasAgrupadas[categoria].sort((a, b) =>
                a.titulo.toLowerCase().localeCompare(b.titulo.toLowerCase(), 'pt-BR')
            );
        });

        let htmlFinal = '';
        Object.entries(receitasAgrupadas)
            .sort(([aId], [bId]) => {
                const nomeA = (categoriasPredefinidas.find(cat => cat.id === aId)?.nome || aId).toLowerCase();
                const nomeB = (categoriasPredefinidas.find(cat => cat.id === bId)?.nome || bId).toLowerCase();
                return nomeA.localeCompare(nomeB, 'pt');
            })
            .forEach(([categoria, receitas]) => {
                const categoriaInfo = categoriasPredefinidas.find(cat => cat.id === categoria) || {
                    emoji: '🍛',
                    nome: 'Almoço'
                };

                htmlFinal += `
                    <div class="categoria-grupo">
                        <h4 class="categoria-titulo" onclick="toggleCategoria(this)">
                            ${categoriaInfo.emoji} ${categoriaInfo.nome} (${receitas.length})
                        </h4>
                        <div class="receitas-categoria oculto">
                            ${receitas.map((receita) => {
                                const indexOriginal = AppState.receitasFavoritas.findIndex(r =>
                                    r.titulo === receita.titulo && r.conteudo === receita.conteudo
                                );
                                return `<div class="item-favorito" onclick="mostrarDetalheFavorito(${indexOriginal})">${receita.titulo}</div>`;
                            }).join('')}
                        </div>
                    </div>
                `;
            });
        listaFiltrada.innerHTML = htmlFinal || '<div class="sem-resultados">🍿 Nenhuma receita aqui</div>';
    } else {
        receitasFiltradas.sort((a, b) => {
            return a.titulo.toLowerCase().localeCompare(b.titulo.toLowerCase(), 'pt-BR');
        });

        if (receitasFiltradas.length === 0) {
            listaFiltrada.innerHTML = '<div class="sem-resultados">🍿 Nenhuma receita aqui</div>';
        } else {
            listaFiltrada.innerHTML = receitasFiltradas.map((receita) => {
                const indexOriginal = AppState.receitasFavoritas.findIndex(r =>
                    r.titulo === receita.titulo && r.conteudo === receita.conteudo
                );
                if (indexOriginal === -1) {
                    const indexFallback = AppState.receitasFavoritas.findIndex(r =>
                        r.titulo === receita.titulo
                    );
                    if (indexFallback !== -1) {
                        return `<div class="item-favorito" onclick="mostrarDetalheFavorito(${indexFallback})">${receita.titulo}</div>`;
                    }
                    return `<div class="item-favorito" onclick="mostrarDetalheFavorito(-1)">${receita.titulo} (erro)</div>`;
                }
                return `<div class="item-favorito" onclick="mostrarDetalheFavorito(${indexOriginal})">${receita.titulo}</div>`;
            }).join('');
        }
    }

    const contador = document.createElement('div');
    contador.className = 'contador-resultados';
    contador.textContent = `${receitasFiltradas.length} receita(s) encontrada(s)`;
    listaFiltrada.insertBefore(contador, listaFiltrada.firstChild);
}, 300);

function filtrarFavoritos() {
    debouncedFilterFavoritos();
}

function toggleCategoria(element) {
    const todasAsCategorias = document.querySelectorAll('.receitas-categoria');

    todasAsCategorias.forEach(cat => {
        if (cat !== element.nextElementSibling) {
            cat.classList.add('oculto');
        }
    });

    const receitasCategoria = element.nextElementSibling;
    if (receitasCategoria) {
        const estavaOculto = receitasCategoria.classList.contains('oculto');
        receitasCategoria.classList.toggle('oculto', !estavaOculto);
    }

    const lista = document.getElementById('listaReceitasFiltradas');
    const algumaAberta = document.querySelector('.receitas-categoria:not(.oculto)');

    if (algumaAberta) {
        lista.style.maxHeight = 'calc(100vh - 180px)';
        lista.style.overflowY = 'auto';
    } else {
        lista.style.maxHeight = 'none';
        lista.style.overflowY = 'hidden';
    }
}

function migrarReceitasAntigas() {
    let houveMigracao = false;

    AppState.receitasFavoritas.forEach(receita => {
        if (!receita.categoria) {
            receita.categoria = sugerirCategoria(receita.titulo, receita.conteudo);
            houveMigracao = true;
        }
    });

    if (houveMigracao) {
        localStorage.setItem('receitasFavoritas', JSON.stringify(AppState.receitasFavoritas));
        console.log('Receitas migradas para o novo sistema de categorias');
    }
}

function formatarReceitaParaExibicao(htmlConteudo) {
    let conteudoProcessado = htmlConteudo || '';
    const tmp = document.createElement('div');
    tmp.innerHTML = conteudoProcessado.trim();

    if (tmp.children.length === 1 && tmp.firstElementChild.classList.contains('recipe-box')) {
        conteudoProcessado = tmp.firstElementChild.innerHTML;
    } else {
        conteudoProcessado = tmp.innerHTML;
    }

    conteudoProcessado = conteudoProcessado
        .replace(/<div class="botoes-receita">[\s\S]*?<\/div>/, '')
        .replace(/<button[^>]*>.*?<\/button>/g, '')
        .replace(/<div class="bom-apetite">[\s\S]*?<\/div>/, '');

    conteudoProcessado = conteudoProcessado
        .replace(/(<br\s*\/?>\s*){2,}/g, '<br>')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/(<strong>[^<]+<\/strong>)<br>/g, '$1\n');

    return conteudoProcessado;
}

function mostrarDetalheFavorito(index) {
    AppState.indiceFavoritoAtual = index;
    const receita = AppState.receitasFavoritas[index];
    const listaTitulos = document.getElementById('listaTitulosFavoritos');
    const receitaCompleta = document.getElementById('receitaCompletaFavorito');
    const conteudoReceita = document.getElementById('conteudoReceitaFavorito');

    if (!listaTitulos || !receitaCompleta || !conteudoReceita) {
        console.error("Erro: Elementos do modal de favoritos não encontrados.");
        return;
    }

    const conteudoFormatado = formatarReceitaParaExibicao(receita.conteudo);

    const receitaFormatadaHTML = `
        <div class="recipe-box">
            <div class="botoes-receita">
                <button onclick="compartilharFavoritoAtual()" class="botao-padrao">🔗 Compartilhar receita</button>
                <button onclick="voltarParaListaFavoritos()" class="botao-padrao">📋 Favoritos</button>
                <button onclick="renomearFavorito()" class="botao-padrao">✏️ Renomear</button>
                <button onclick="mudarCategoriaFavorito()" class="botao-padrao">🏷️ Mudar</button>
                <button onclick="excluirFavoritoAtual()" class="botao-excluir">🗑️ Excluir</button>
            </div>
            ${conteudoFormatado}
            <div class="bom-apetite">
    <span onclick="abrirRemy('imagens/remy.mp4')" style="cursor:pointer;">
        Qualquer um pode cozinhar!
    </span>
    <img src="imagens/assbaron.png" alt="baron" class="emoji-img">
</div>
        </div>
    `;

    conteudoReceita.innerHTML = receitaFormatadaHTML;
    listaTitulos.classList.add('oculto');
    receitaCompleta.classList.remove('oculto');
}

function compartilharFavoritoAtual() {
    if (AppState.indiceFavoritoAtual >= 0) {
        const receita = AppState.receitasFavoritas[AppState.indiceFavoritoAtual];
        const titulo = extrairTitulo(receita.conteudo);
        compartilharReceita(titulo, receita.conteudo);
    }
}

function excluirFavoritoAtual() {
    if (AppState.indiceFavoritoAtual >= 0) {
        const receita = AppState.receitasFavoritas[AppState.indiceFavoritoAtual];
        mostrarModalConfirmacaoExclusao(receita.titulo);
    }
}

function mostrarModalConfirmacaoExclusao(tituloReceita) {
    const content = `
        <p class="modal-subtitulo" style="text-align: center; margin: 20px 0;">
            Tem certeza que deseja excluir permanentemente a receita?
        </p>
        <p style="text-align: center; font-weight: bold; font-size: 14px; margin: 10px 0; color: #333;">
            <span style="color: #c64a0a;">"${tituloReceita}"</span>
        </p>
        <p style="text-align: center; color: #666; font-size: 14px; margin-bottom: 25px;">
            Esta ação não pode ser desfeita!
        </p>
    `;

    const actions = `
        <button id="btn-confirmar-exclusao" class="btn-confirmar-novo">Sim, excluir</button>
        <button class="btn-cancelar-novo">Cancelar</button>
    `;

    const modal = ModalManager.open({
        title: '🗑️ Confirmar Exclusão',
        content: content,
        actions: actions
    });

    if (!modal) return;

    document.getElementById('btn-confirmar-exclusao').addEventListener('click', function() {
        confirmarExclusaoFavorito();
        ModalManager.close(modal);
    });

    modal.querySelector('.btn-cancelar-novo').addEventListener('click', function() {
        ModalManager.close(modal);
    });
}

function confirmarExclusaoFavorito() {
    if (AppState.indiceFavoritoAtual >= 0) {
        AppState.receitasFavoritas.splice(AppState.indiceFavoritoAtual, 1);
        localStorage.setItem('receitasFavoritas', JSON.stringify(AppState.receitasFavoritas));

        showCustomModal('Receita excluída dos favoritos');

        if (AppState.receitasFavoritas.length === 0) {
            fecharModalFavoritos();
        } else {
            // CORREÇÃO: Remover a chamada duplicada
            // A função mostrarFavoritosComBusca() já deve resetar a visualização
            mostrarFavoritosComBusca();
        }
    }
}

function mudarCategoriaFavorito() {
    if (AppState.modalAberto || AppState.indiceFavoritoAtual < 0) return;

    const receita = AppState.receitasFavoritas[AppState.indiceFavoritoAtual];

    const content = `
        <p class="modal-subtitulo">${receita.titulo}</p>
        <br>
        <div class="categorias-grid-novo">
            ${categoriasPredefinidas.filter(cat => cat.id !== '').map(categoria => `
                <button class="categoria-btn-novo" data-categoria="${categoria.id}">
                    ${categoria.emoji} ${categoria.nome}
                </button>
            `).join('')}
        </div>
    `;

    const actions = `
        <button id="btn-confirmar-mudanca" class="btn-confirmar-novo">Atualizar</button>
        <button class="btn-cancelar-novo">Cancelar</button>
    `;

    const modal = ModalManager.open({
        title: '🏷️ Mudar de Categoria',
        content: content,
        actions: actions
    });

    if (!modal) return;

    const suggestedButton = modal.querySelector(`.categoria-btn-novo[data-categoria="${receita.categoria}"]`);
    if (suggestedButton) {
        suggestedButton.classList.add('selecionado');
    }

    modal.addEventListener('click', function(e) {
        if (e.target.classList.contains('categoria-btn-novo')) {
            modal.querySelectorAll('.categoria-btn-novo').forEach(b => b.classList.remove('selecionado'));
            e.target.classList.add('selecionado');
        }
    });

    modal.querySelector('.btn-cancelar-novo').addEventListener('click', function() {
        ModalManager.close(modal);
    });

    document.getElementById('btn-confirmar-mudanca').addEventListener('click', function() {
        const categoriaSelecionada = modal.querySelector('.categoria-btn-novo.selecionado')?.dataset?.categoria;

        if (categoriaSelecionada) {
            atualizarCategoriaFavorito(AppState.indiceFavoritoAtual, categoriaSelecionada);
            ModalManager.close(modal);
        } else {
            showCustomModal('Selecione uma categoria');
        }
    });
}

function renomearFavorito() {
    if (AppState.indiceFavoritoAtual < 0 || AppState.modalAberto) return;

    const receita = AppState.receitasFavoritas[AppState.indiceFavoritoAtual];

    const content = `
        <p class="modal-subtitulo">Digite o novo nome:</p>
        <input type="text" id="novoNomeReceita" value="${escapeHtml(receita.titulo)}"
               placeholder="Nome da receita" style="width: 100%; padding: 10px; margin: 15px 0;
               border: 1px solid #ddd; border-radius: 8px; font-size: 16px;">
    `;

    const actions = `
        <button id="btn-confirmar-renomear" class="btn-confirmar-novo">Salvar</button>
        <button class="btn-cancelar-novo">Cancelar</button>
    `;

    const modal = ModalManager.open({
        title: '✏️ Renomear Receita',
        content: content,
        actions: actions
    });

    if (!modal) return;

    setTimeout(() => {
        const input = document.getElementById('novoNomeReceita');
        if (input) {
            input.focus();
            input.select();
        }
    }, 100);

    modal.querySelector('.btn-cancelar-novo').addEventListener('click', function() {
        ModalManager.close(modal);
    });

    document.getElementById('btn-confirmar-renomear').addEventListener('click', function() {
        const novoNome = document.getElementById('novoNomeReceita').value.trim();
        if (novoNome) {
            confirmarRenomearFavorito(novoNome, modal);
        } else {
            showCustomModal('Digite o novo nome:');
        }
    });

    const inputNome = document.getElementById('novoNomeReceita');
    inputNome.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('btn-confirmar-renomear').click();
        }
    });
}

function confirmarRenomearFavorito(novoNome, modal) {
    if (AppState.indiceFavoritoAtual >= 0) {
        const receitaExistente = AppState.receitasFavoritas.find((receita, index) =>
            index !== AppState.indiceFavoritoAtual &&
            receita.titulo.toLowerCase() === novoNome.toLowerCase()
        );

        if (receitaExistente) {
            mostrarModalSobrescrever(receitaExistente, novoNome, modal);
            return;
        }

        realizarRenomeacao(novoNome, modal);
    }
}

function mostrarModalSobrescrever(receitaExistente, novoNome, modalRenomear) {
    const content = `
        <p class="modal-subtitulo">Já existe uma receita chamada:<br>
            <strong>"${escapeHtml(receitaExistente.titulo)}"</strong>
        </p>
        <p style="text-align: center; margin: 15px 0; color: #666; font-size: 14px;">
            O que você deseja fazer?
        </p>
    `;

    const actions = `
        <button id="btn-sobrescrever" class="btn-excluir-confirmar">Renomear</button>
        <button id="btn-cancelar-sobrescrever" class="btn-cancelar-novo">Alterar</button>
    `;

    const modal = ModalManager.open({
        title: '⚠️ Nome já existe',
        content: content,
        actions: actions
    });

    if (!modal) return;

    document.getElementById('btn-sobrescrever').addEventListener('click', function() {
        const indexExistente = AppState.receitasFavoritas.findIndex(r =>
            r.titulo.toLowerCase() === receitaExistente.titulo.toLowerCase()
        );

        if (indexExistente !== -1) {
            AppState.receitasFavoritas.splice(indexExistente, 1);
        }

        realizarRenomeacao(novoNome, modalRenomear);
        ModalManager.close(modal);
    });

    document.getElementById('btn-cancelar-sobrescrever').addEventListener('click', function() {
        ModalManager.close(modal);
        ModalManager.close(modalRenomear);

        setTimeout(() => {
            renomearFavorito();
        }, 100);
    });
}

function realizarRenomeacao(novoNome, modal) {
    AppState.receitasFavoritas[AppState.indiceFavoritoAtual].titulo = novoNome;

    const conteudoAtual = AppState.receitasFavoritas[AppState.indiceFavoritoAtual].conteudo;
    const novoConteudo = conteudoAtual.replace(
        /<strong>(.*?)<\/strong>/,
        `<strong>${escapeHtml(novoNome)}</strong>`
    );
    AppState.receitasFavoritas[AppState.indiceFavoritoAtual].conteudo = novoConteudo;

    localStorage.setItem('receitasFavoritas', JSON.stringify(AppState.receitasFavoritas));

    ModalManager.close(modal);
    showCustomModal('Nome da receita atualizado!');

    const conteudoReceita = document.getElementById('conteudoReceitaFavorito');
    if (conteudoReceita && conteudoReceita.innerHTML.includes('recipe-box')) {
        mostrarDetalheFavorito(AppState.indiceFavoritoAtual);
    }

    if (document.getElementById('modalFavoritos') &&
        !document.getElementById('modalFavoritos').classList.contains('oculto')) {
        filtrarFavoritos();
    }
}

function atualizarCategoriaFavorito(indice, novaCategoria) {
    if (indice >= 0 && indice < AppState.receitasFavoritas.length) {
        AppState.receitasFavoritas[indice].categoria = novaCategoria;
        localStorage.setItem('receitasFavoritas', JSON.stringify(AppState.receitasFavoritas));

        const categoriaEncontrada = categoriasPredefinidas.find(cat => cat.id === novaCategoria);
        const categoriaNomeComEmoji = categoriaEncontrada ? `${categoriaEncontrada.emoji} ${categoriaEncontrada.nome}` : 'Outros';

        showCustomModal(`Sua receita está em ${categoriaNomeComEmoji}`);
    }
}

function fecharModalFavoritos() {
    document.getElementById('modalFavoritos').classList.add('oculto');
}

function voltarParaListaFavoritos() {
    const listaTitulos = document.getElementById('listaTitulosFavoritos');
    const receitaCompleta = document.getElementById('receitaCompletaFavorito');
    const conteudoReceita = document.getElementById('conteudoReceitaFavorito');

    if (listaTitulos) listaTitulos.classList.remove('oculto');
    if (receitaCompleta) receitaCompleta.classList.add('oculto');
    if (conteudoReceita) conteudoReceita.innerHTML = '';
    AppState.indiceFavoritoAtual = -1;
    filtrarFavoritos();
}

// === IMPORT/EXPORT FUNCTIONS ===
function salvarArquivo(dirEntry, fileName, blob) {
    dirEntry.getFile(fileName, {
            create: true,
            exclusive: false
        },
        function(fileEntry) {
            fileEntry.createWriter(
                function(fileWriter) {
                    fileWriter.onwriteend = function() {
                        showPersistentModal(fileName);
                        console.log("Arquivo salvo: " + fileEntry.fullPath);
                    };
                    fileWriter.onerror = function(e) {
                        console.error("Erro ao escrever:", e);
                        showCustomModal("Erro ao exportar receitas");
                    };
                    fileWriter.write(blob);
                },
                function(error) {
                    console.error("Erro ao criar escritor:", error);
                    showCustomModal("Erro ao exportar receitas");
                }
            );
        },
        function(error) {
            console.error("Erro ao criar arquivo:", error);
            showCustomModal("Erro ao exportar receitas");
        }
    );
}

function exportarFavoritosComCategorias() {
    if (AppState.receitasFavoritas.length === 0) {
        showCustomModal("Nenhuma receita favorita para exportar.");
        return;
    }

    migrarReceitasAntigas();

    const now = new Date();
    const dia = String(now.getDate()).padStart(2, '0');
    const mes = String(now.getMonth() + 1).padStart(2, '0');
    const ano = String(now.getFullYear()).slice(-2);
    const hora = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');

    const fileName = `meuchef_${dia}${mes}${ano}_${hora}${min}.json`;

    const dadosExportacao = {
        versao: "2.0",
        dataExportacao: new Date().toISOString(),
        totalReceitas: AppState.receitasFavoritas.length,
        categorias: {},
        receitas: AppState.receitasFavoritas
    };

    AppState.receitasFavoritas.forEach(receita => {
        const categoria = receita.categoria || 'outros';
        if (!dadosExportacao.categorias[categoria]) {
            dadosExportacao.categorias[categoria] = 0;
        }
        dadosExportacao.categorias[categoria]++;
    });

    const jsonData = JSON.stringify(dadosExportacao, null, 2);
    const blob = new Blob([jsonData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showCustomModal(`✅ Receitas exportadas como ${fileName}`);
}

function importarFavoritos(event) {
    const file = event.target.files[0];
    if (!file) {
        showCustomModal("Nenhum arquivo selecionado.");
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const dados = JSON.parse(e.target.result);
            let receitasParaImportar = null;
            let importadasComSucesso = 0;
            let ignoradasPorDuplicidade = 0;

            if (dados && typeof dados === 'object' && Array.isArray(dados.receitas)) {
                receitasParaImportar = dados.receitas;
            } else if (Array.isArray(dados)) {
                receitasParaImportar = dados;
            }

            if (receitasParaImportar) {
                const receitasExistentes = JSON.parse(localStorage.getItem('receitasFavoritas')) || [];

                function extrairIngredientes(html) {
                    if (!html) return [];
                    const match = html.match(/🌿 Ingredientes([\s\S]*?)(<strong>|<\/div>|$)/i);
                    if (!match) return [];
                    return match[1]
                        .replace(/<[^>]*>/g, '')
                        .split('\n')
                        .map(i => i.trim().toLowerCase())
                        .filter(i => i && !i.startsWith('🌿 ingredientes'));
                }

                const existentesNormalizados = receitasExistentes.map(r => ({
                    titulo: (r.titulo || '').trim(),
                    conteudo: (r.conteudo || '').replace(/\s+/g, ' ').trim(),
                    ingredientes: extrairIngredientes(r.conteudo).sort().join('|')
                }));

                const novasReceitas = receitasParaImportar.map(r => {
                    let tituloOriginal = (r.titulo || '').trim();
                    let conteudoNormalizado = (r.conteudo || '').replace(/\s+/g, ' ').trim();
                    let ingredientesNormalizados = extrairIngredientes(r.conteudo).sort().join('|');

                    let conflitos = existentesNormalizados.filter(e => e.titulo === tituloOriginal);

                    if (conflitos.length > 0) {
                        let mesmaReceita = conflitos.some(e =>
                            e.conteudo === conteudoNormalizado ||
                            e.ingredientes === ingredientesNormalizados
                        );

                        if (mesmaReceita) {
                            ignoradasPorDuplicidade++;
                            return null;
                        } else {
                            let contadorVersao = 1;
                            let novoTitulo;
                            do {
                                contadorVersao++;
                                novoTitulo = `${tituloOriginal} v${contadorVersao}`;
                            } while (
                                existentesNormalizados.some(e => e.titulo === novoTitulo) ||
                                receitasParaImportar.some(o => o !== r && o.titulo === novoTitulo)
                            );
                            r.titulo = novoTitulo;
                            importadasComSucesso++;
                            return r;
                        }
                    }
                    importadasComSucesso++;
                    return r;
                }).filter(r => r !== null);

                AppState.receitasFavoritas = [...receitasExistentes, ...novasReceitas];
                localStorage.setItem('receitasFavoritas', JSON.stringify(AppState.receitasFavoritas));

                migrarReceitasAntigas();
                mostrarFavoritosComBusca();

                showCustomModal(`Importação concluída: ${importadasComSucesso} adicionada(s), ${ignoradasPorDuplicidade} ignorada(s) por duplicidade.`);

            } else {
                showCustomModal("Arquivo inválido. O formato deve ser um array ou um objeto com a chave 'receitas'.");
            }
        } catch (err) {
            console.error("Erro ao ler arquivo: ", err);
            showCustomModal("Erro ao importar. Verifique o arquivo.");
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}

function showPersistentModal(fileName) {
    const existingModal = document.querySelector('.custom-modal-overlay');
    if (existingModal) existingModal.remove();

    const overlay = document.createElement('div');
    overlay.className = 'custom-modal-overlay';

    const modalContent = document.createElement('div');
    modalContent.className = 'custom-modal-content';
    modalContent.innerHTML = `
        <p style="font-size: 13px; line-height: 1.4;">
            Receitas exportadas para a pasta Downloads como:
            <br><br>
            <span style="color: #8d6e63; font-weight: 600;">${fileName}</span>
            <br><br>
            <span style="color: #5d4037; font-size: 12px;">💾 Salve este arquivo em local seguro para importar depois</span>
        </p>
        <div style="text-align: center; margin-top: 16px;">
            <button id="btnFecharModal" style="padding: 8px 16px; font-size: 14px; font-weight: 600; color: #6a4c93; background: #f3e5f5; border: 1px solid #ce93d8; border-radius: 8px;">OK</button>
        </div>
    `;

    overlay.appendChild(modalContent);
    document.body.appendChild(overlay);

    document.getElementById('btnFecharModal').addEventListener('click', () => {
        overlay.remove();
    });
}

// === SHARE FUNCTION ===
// === SHARE FUNCTION ===
function compartilharReceita(titulo, conteudoHTML) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = conteudoHTML;
    const recipeOutput = tempDiv.querySelector('.recipe-output');
    let conteudoParaCompartilhar = recipeOutput ? recipeOutput.innerHTML : conteudoHTML;
    conteudoParaCompartilhar = conteudoParaCompartilhar.replace(/<strong>[^<]*<\/strong>(\s*<br>\s*)*/i, '').replace(/<div class="botoes-receita">[\s\S]*?<\/div>/gi, '').replace(/<div class="bom-apetite">[\s\S]*?<\/div>/gi, '');
    const conteudoLimpo = conteudoParaCompartilhar.replace(/<br\s*\/?>/gi, '\n').replace(/<strong>(.*?)<\/strong>/g, '$1').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '').replace(/(\n)\s+/g, '$1');
    let textoFormatado = `${titulo}\n\n${conteudoLimpo.trim()}`;
    textoFormatado = textoFormatado.replace(/(🌿 Ingredientes)/, '\n$1\n').replace(/(🥘 Modo de Preparo)/, '\n$1\n').replace(/(⏳ Tempo de Preparo)/, '\n$1\n').replace(/(🧺 Rendimento)/, '\n$1\n').replace(/(⭐ Dicas do Chef)/, '\n$1\n').replace(/(🍹 Acompanhamento)/, '\n$1\n').replace(/(🥗 Guarnição)/, '\n$1\n');
    textoFormatado = textoFormatado.replace(/(🥘 Modo de Preparo\n)([\s\S]*?)(?=\n\n⏳|\n\n🧺|\n\n⭐|\n\n🍹|\n\n🥗|$)/, (match, tituloSecao, conteudoSecao) => { const passos = conteudoSecao.split('\n').filter(passo => passo.trim()).map((passo, index) => { const passoLimpo = passo.replace(/^\s*\d+\.\s*/, '').trim(); return passoLimpo ? `${index + 1}. ${passoLimpo}` : ''; }).filter(passo => passo !== '').join('\n'); return `${tituloSecao}${passos}\n`; });
    textoFormatado = textoFormatado.replace(/\n{3,}/g, '\n\n');
    const shareText = `${textoFormatado}\n\nQualquer um pode cozinhar!\nBom apetite!`;
    const scrollPosition = window.scrollY || window.pageYOffset;
    const restaurarScroll = () => { setTimeout(() => window.scrollTo(0, scrollPosition), 100); };
    if (navigator.share) {
        navigator.share({ title: titulo, text: shareText }).then(() => restaurarScroll()).catch(() => restaurarScroll());
    } else {
        navigator.clipboard.writeText(shareText).then(() => { showCustomModal('📋 Receita copiada!'); restaurarScroll(); }).catch(() => { showCustomModal('❌ Não foi possível compartilhar'); restaurarScroll(); });
    }
}

// === MAIN GENERATION FUNCTIONS ===
async function gerarReceita(event) {
    const entrada = document.getElementById('userInput').value.trim();
    if (!entrada) {
        const mensagemAlerta = document.getElementById('mensagemAlerta');
        if (mensagemAlerta) {
            mensagemAlerta.classList.remove('alerta-oculto');
            mensagemAlerta.classList.add('alerta-visivel');
            mensagemAlerta.style.animation = 'none';
            void mensagemAlerta.offsetWidth;
            mensagemAlerta.style.animation = 'fadeInOut 5s forwards';
            setTimeout(() => {
                mensagemAlerta.classList.remove('alerta-visivel');
                mensagemAlerta.classList.add('alerta-oculto');
                mensagemAlerta.style.animation = 'none';
            }, 5000);
        }
        return;
    }

    // Detecção melhorada de bebidas
    const palavrasChaveBebida = ['bebida', 'suco', 'chá', 'coquetel', 'drink', 'caipirinha', 'batida', 'vitamina', 
                               'cachaça', 'vodka', 'gin', 'rum', 'tequila', 'cerveja', 'vinho', 'licor', 'refresco'];
    
    const entradaMinuscula = entrada.toLowerCase();
    const isBebida = palavrasChaveBebida.some(palavra => entradaMinuscula.includes(palavra));
    
    const tipoPratoInferido = isBebida ? "drink" : sugerirCategoria("", "", entrada);

    AppState.ultimaEntrada = entrada;
    const botao = event.target;
    const textoOriginalBotao = botao.innerHTML;
    await handleRecipeGeneration(entrada, botao, textoOriginalBotao, tipoPratoInferido, "primeira");
}
 
async function gerarOutraReceita() {
    const entradaAtual = document.getElementById('userInput').value.trim();
    let modoGeracao = "variacao";

    if (entradaAtual && AppState.ultimaEntrada && entradaAtual !== AppState.ultimaEntrada) {
        modoGeracao = "nova";
    } else if (!entradaAtual && AppState.ultimaEntrada) {
        modoGeracao = "variacao";
    } else if (entradaAtual && !AppState.ultimaEntrada) {
        modoGeracao = "primeira";
    }

    if (AppState.isGenerating) return;
    AppState.isGenerating = true;

    if (!AppState.ultimaEntrada && (modoGeracao === "variacao")) {
        console.warn('Tentativa de gerar variação sem entrada anterior ou nova entrada.');
        AppState.isGenerating = false;
        showCustomModal('⚠️ Primeiro crie uma receita para depois gerar variações ou digite novos ingredientes.');
        return;
    }

    const resultadoDiv = document.getElementById('resultado');
    const opcoesDiv = document.getElementById('opcoes');
    const btnGerarNova = document.getElementById('btnGerarNova');
    const botoesDiv = document.querySelector('.botoes-empilhados');
    const imagemInicial = document.getElementById('imagemInicial');

    if (!resultadoDiv || !opcoesDiv || !btnGerarNova || !botoesDiv || !imagemInicial) {
        console.error("Erro: Um ou mais elementos HTML necessários não foram encontrados para 'gerarOutraReceita'.");
        AppState.isGenerating = false;
        return;
    }

    const textoOriginalBotao = btnGerarNova.innerHTML;
    btnGerarNova.classList.add('loading');
    btnGerarNova.innerHTML = '<span class="spin-animation">🥘</span> Buscando sua receita';
    btnGerarNova.disabled = true;

    try {
        console.log('Iniciando geração de receita... Modo:', modoGeracao);

        let tipoPratoParaGeracao;
        let isAlternativa = false;
        let promptParaIA = entradaAtual;

        if (modoGeracao === "variacao") {
            tipoPratoParaGeracao = AppState.ultimoTipoPratoGerado;
            isAlternativa = true;
            promptParaIA = AppState.ultimaEntrada || AppState.ultimaReceitaGerada;
        } else if (modoGeracao === "nova" || modoGeracao === "primeira") {
            tipoPratoParaGeracao = sugerirCategoria("", "", entradaAtual);
            isAlternativa = false;
            AppState.ultimaEntrada = entradaAtual;
        }

        const receita = await gerarReceitaComIA(promptParaIA, isAlternativa, tipoPratoParaGeracao);

        console.log('Receita gerada com sucesso!');

        AppState.ultimaReceitaGerada = receita;
        AppState.ultimoTipoPratoGerado = sugerirCategoria(extrairTitulo(receita), receita, promptParaIA);

        resultadoDiv.innerHTML = RecipeFormatter.formatResponse(receita);

        imagemInicial.style.display = 'none';
        botoesDiv.style.display = 'none';
        opcoesDiv.classList.remove('oculto');
        opcoesDiv.classList.add('show');

        btnGerarNova.innerHTML = '🥣 Tente algo diferente';
        btnGerarNova.disabled = false;
        btnGerarNova.classList.remove('loading');

    } catch (error) {
        handleGenerationError(error, resultadoDiv, imagemInicial, botoesDiv, opcoesDiv, btnGerarNova, textoOriginalBotao);
    } finally {
        AppState.isGenerating = false;
    }
}

async function handleRecipeGeneration(entrada, botao, textoOriginal, tipoPratoInicial, modo = "normal") {
    if (AppState.isGenerating) return;
    AppState.isGenerating = true;

    const resultadoDiv = document.getElementById('resultado');
    const opcoesDiv = document.getElementById('opcoes');
    const botoesDiv = document.querySelector('.botoes-empilhados');
    const imagemInicial = document.getElementById('imagemInicial');
    const btnGerarNova = document.getElementById('btnGerarNova');

    if (!resultadoDiv || !opcoesDiv || !botoesDiv || !imagemInicial || !botao || !btnGerarNova) {
        console.error("Erro: Um ou mais elementos HTML necessários não foram encontrados.");
        AppState.isGenerating = false;
        return;
    }

    // Estado do botão durante geração
    botao.classList.add('loading');
    botao.innerHTML = '<span class="spin-animation">🥘</span> Criando sua receita';
    botao.disabled = true;

    // Oculta opções enquanto gera
    opcoesDiv.classList.remove('show');
    opcoesDiv.classList.add('oculto');

    try {
        console.log('Iniciando geração de receita... Modo:', modo);

        let tipoPratoParaGeracao;
        let isAlternativa = false;

        if (modo === "variacao") {
            tipoPratoParaGeracao = AppState.ultimoTipoPratoGerado;
            isAlternativa = true;
        } else {
            tipoPratoParaGeracao = tipoPratoInicial;
            isAlternativa = false;
            AppState.ultimaEntrada = entrada;
        }

        // Geração da receita via IA
        let receita = await gerarReceitaComIA(entrada, isAlternativa, tipoPratoParaGeracao);

        // --- DEBUG DA API ---
        console.log('Resposta da API recebida:');
        debugAPIResponse(receita);
        // --------------------

        AppState.ultimaReceitaGerada = receita;
        AppState.ultimoTipoPratoGerado = sugerirCategoria(extrairTitulo(receita), receita, entrada);

        console.log('Receita gerada com sucesso!');

        // Atualiza DOM com a receita
        resultadoDiv.innerHTML = RecipeFormatter.formatResponse(receita);
        resultadoDiv.classList.remove('empty');

        imagemInicial.style.display = 'none';
        botoesDiv.style.display = 'none';

        // Configura botão de gerar nova receita
        btnGerarNova.innerHTML = '🥣 Tente algo diferente';
        btnGerarNova.onclick = gerarOutraReceita;

        opcoesDiv.classList.remove('oculto');
        opcoesDiv.classList.add('show');

    } catch (error) {
        handleGenerationError(error, resultadoDiv, imagemInicial, botoesDiv, opcoesDiv, botao, textoOriginal);
    } finally {
        botao.classList.remove('loading');
        if (botao.id !== 'btnGerarNova') {
            botao.innerHTML = textoOriginal;
        }
        botao.disabled = false;
        AppState.isGenerating = false;
    }
}

// === UI HELPER FUNCTIONS ===
function refreshApp() {
    const appContent = document.getElementById('app-content');
    appContent.style.opacity = '0.5';
    setTimeout(() => {
        resetApp();
        appContent.style.opacity = '1';
    }, 500);
}

function adicionarSugestao(sugestao) {
    document.getElementById('userInput').value = sugestao;
}

// === INITIALIZATION ===
document.addEventListener('DOMContentLoaded', function() {
    AppState.receitasFavoritas = JSON.parse(localStorage.getItem('receitasFavoritas')) || [];
    migrarReceitasAntigas();

    window.exportarFavoritos = exportarFavoritosComCategorias;
    console.log('Sistema de busca e categorias inicializado!');

    const splashScreen = document.getElementById('splash-screen');
    const appContent = document.getElementById('app-content');

    if (splashScreen && appContent) {
        if (sessionStorage.getItem('splash_visto')) {
            splashScreen.style.display = 'none';
            appContent.style.display = 'block';
            sessionStorage.removeItem('splash_visto');
        } else {
            setTimeout(function() {
                splashScreen.classList.add('fade-out');
                splashScreen.addEventListener('transitionend', function() {
                    splashScreen.style.display = 'none';
                    appContent.style.display = 'block';
                    sessionStorage.setItem('splash_visto', 'true');
                }, {
                    once: true
                });
            }, 3000);
        }
    }

    const userInput = document.getElementById('userInput');
    if (userInput) {
        userInput.addEventListener('input', function() {
            const valorAtual = this.value.trim();
            const btnGerarNova = document.getElementById('btnGerarNova');

            if (!btnGerarNova) return;

            if (!AppState.ultimaEntrada && !valorAtual) {
                btnGerarNova.innerHTML = '🥘 Crie uma receita pra mim';
                btnGerarNova.onclick = function() {
                    gerarReceita({
                        target: btnGerarNova
                    });
                };
            } else if (AppState.ultimaEntrada && valorAtual && valorAtual !== AppState.ultimaEntrada) {
                btnGerarNova.innerHTML = '🥣 Tente algo diferente';
                btnGerarNova.onclick = gerarOutraReceita;
            } else if (AppState.ultimaEntrada) {
                btnGerarNova.innerHTML = '🥣 Tente algo diferente';
                btnGerarNova.onclick = gerarOutraReceita;
            } else if (valorAtual && !AppState.ultimaEntrada) {
                btnGerarNova.innerHTML = '🥘 Crie uma receita pra mim';
                btnGerarNova.onclick = function() {
                    gerarReceita({
                        target: btnGerarNova
                    });
                };
            }
        });

        userInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const botaoPrincipal = document.querySelector('.botoes-empilhados button');
                if (botaoPrincipal) {
                    gerarReceita({
                        target: botaoPrincipal
                    });
                }
            }
        });
    }
});
