const crypto = require('crypto');

// Map of word numbers to their numeric values
const wordToNumber = {
    'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4,
    'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9,
    'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13,
    'fourteen': 14, 'fifteen': 15, 'sixteen': 16, 'seventeen': 17,
    'eighteen': 18, 'nineteen': 19, 'twenty': 20
};

// Map of numbers to their word representations (only needed up to 10 for generation)
const numberToWord = {
    0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four',
    5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine',
    10: 'ten'
};

// Supported operators and their functions
const operators = {
    '+': (a, b) => a + b,
    '-': (a, b) => a - b,
    '−': (a, b) => a - b,  // Unicode minus sign (U+2212)
    '×': (a, b) => a * b,
    '*': (a, b) => a * b
};

/**
 * Generates a random number between min and max (inclusive)
 */
function getRandomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generates a random operator from the supported list
 */
function getRandomOperator() {
    const ops = Object.keys(operators);
    return ops[Math.floor(Math.random() * ops.length)];
}

/**
 * Creates a captcha equation with support for mixed format (numbers and words)
 * @param {string} format - 'mixed', 'words', or 'numbers'
 * @param {boolean} firstOperandWord - Force first operand to be word (for mixed format)
 */
function generateCaptcha(format = 'numbers', firstOperandWord = false) {
    const num1 = getRandomNumber(1, 10);
    const num2 = getRandomNumber(1, 10);
    const operator = getRandomOperator();
    
    // Calculate the result
    const result = operators[operator](num1, num2);
    
    // Generate a unique string for verification
    const timestamp = Date.now().toString();
    const randomString = crypto.randomBytes(5).toString('hex');
    const verificationString = `${timestamp}${randomString}`;
    
    // Create the equation string based on format
    let equation;
    switch (format) {
        case 'mixed':
            if (firstOperandWord) {
                equation = `${numberToWord[num1]} ${operator} ${num2}`;
            } else {
                equation = `${num1} ${operator} ${numberToWord[num2]}`;
            }
            break;
        case 'words':
            equation = `${numberToWord[num1]} ${operator} ${numberToWord[num2]}`;
            break;
        default: // numbers
            equation = `${num1} ${operator} ${num2}`;
    }
    
    return {
        equation,
        result: Math.round(result), // Round for division cases
        verificationString
    };
}

/**
 * Verifies if the provided answer matches the expected result
 */
function verifyCaptcha(answer, expectedResult) {
    return parseInt(answer, 10) === expectedResult;
}

/**
 * Generates the HTML for the captcha
 * @param {string} format - 'mixed', 'words', or 'numbers'
 * @param {boolean} firstOperandWord - Force first operand to be word (for mixed format)
 */
function generateCaptchaHTML(format = 'numbers', firstOperandWord = false) {
    const { equation, result, verificationString } = generateCaptcha(format, firstOperandWord);
    
    return {
        html: `
            <p class="aiowps-captcha hide-when-displaying-tfa-input"><label for="aiowps-captcha-answer">Please enter an answer in digits:</label></p>
            <div class="aiowps-captcha-equation hide-when-displaying-tfa-input">
                <strong>${equation} = 
                    <input type="hidden" name="aiowps-captcha-string-info" class="aiowps-captcha-string-info" value="${verificationString}">
                    <input type="hidden" name="aiowps-captcha-temp-string" class="aiowps-captcha-temp-string" value="${result}">
                    <input type="text" size="2" class="aiowps-captcha-answer" name="aiowps-captcha-answer" value="" autocomplete="off">
                </strong>
            </div>
        `,
        result,
        verificationString
    };
}

/**
 * Converts a string number or word to its numeric value
 * @param {string} value - The number or word to convert
 * @returns {number} The numeric value
 */
function parseNumberOrWord(value) {
    try {
        // Remove any whitespace and convert to lowercase
        value = value.trim().toLowerCase();
        
        // If it's a numeric string, parse it
        if (/^\d+$/.test(value)) {
            return parseInt(value, 10);
        }
        
        // If it's a word, convert it
        if (wordToNumber.hasOwnProperty(value)) {
            return wordToNumber[value];
        }
        
        console.error(`Unable to parse value: ${value}`);
        console.log('Available word numbers:', Object.keys(wordToNumber).join(', '));
        throw new Error(`Unable to parse value: ${value}`);
    } catch (error) {
        console.error('Error in parseNumberOrWord:', error);
        throw error;
    }
}

/**
 * Normalizes operators to handle different minus sign representations
 * @param {string} equation - The equation to normalize
 * @returns {string} - Normalized equation
 */
function normalizeOperators(equation) {
    // Replace hyphen-minus with Unicode minus
    return equation.replace(/-/g, '−');
}

/**
 * Extracts operator from equation
 * @param {string} equation - The equation to parse
 * @returns {string} - The operator found
 */
function extractOperator(equation) {
    const normalizedEq = normalizeOperators(equation);
    for (const op of Object.keys(operators)) {
        if (normalizedEq.includes(op)) {
            return op;
        }
    }
    throw new Error(`No supported operator found in equation: ${equation}`);
}

/**
 * Solves a captcha equation string
 * @param {string} equation - The equation to solve (e.g., "12 − three")
 * @returns {number} The solution to the equation
 */
function solveCaptcha(equation) {
    try {
        // Clean up and normalize the equation
        equation = normalizeOperators(equation.trim());
        console.log('Processing normalized equation:', equation);
        
        const operator = extractOperator(equation);
        console.log('Found operator:', operator);
        
        // Split the equation using the exact operator
        const parts = equation.split(operator).map(p => p.trim());
        console.log('Equation parts:', parts);
        
        const num1 = parseNumberOrWord(parts[0]);
        const num2 = parseNumberOrWord(parts[1]);
        
        console.log('Parsed numbers:', num1, operator, num2);
        
        const result = operators[operator](num1, num2);
        console.log('Calculated result:', result);
        return result;
    } catch (error) {
        console.error('Error in solveCaptcha:', error);
        throw error;
    }
}

/**
 * Triple checks a captcha solution to ensure accuracy
 * @param {string} equation - The equation to solve
 * @returns {number} The verified solution
 */
function tripleCheckSolution(equation) {
    console.log('Triple checking equation:', equation);
    
    // First check - normal solve
    const solution1 = solveCaptcha(equation);
    console.log('First check result:', solution1);
    
    // Second check - solve with normalized operators
    const solution2 = solveCaptcha(normalizeOperators(equation));
    console.log('Second check result:', solution2);
    
    // Third check - solve parts individually and combine
    const operator = extractOperator(equation);
    const parts = equation.split(operator).map(p => p.trim());
    const num1 = parseNumberOrWord(parts[0]);
    const num2 = parseNumberOrWord(parts[1]);
    const solution3 = operators[operator](num1, num2);
    console.log('Third check result:', solution3);
    
    // Verify all solutions match
    if (solution1 !== solution2 || solution2 !== solution3) {
        console.error('Solution mismatch detected!');
        console.error(`Solution 1: ${solution1}`);
        console.error(`Solution 2: ${solution2}`);
        console.error(`Solution 3: ${solution3}`);
        throw new Error('Inconsistent captcha solutions');
    }
    
    console.log('All checks passed. Verified solution:', solution1);
    return solution1;
}

/**
 * Extracts and solves the captcha from a login page HTML with triple verification
 * @param {string} html - The HTML containing the captcha
 * @returns {Object} The captcha solution and verification info
 */
function extractAndSolveCaptcha(html) {
    try {
        // Extract the equation
        const equationMatch = html.match(/class="aiowps-captcha-equation[^>]*><strong>([^=]+)=/);
        if (!equationMatch) {
            throw new Error('Could not find captcha equation');
        }
        
        const equation = equationMatch[1].trim();
        console.log('Extracted equation:', equation);
        
        // Extract the verification strings
        const stringInfoMatch = html.match(/name="aiowps-captcha-string-info"[^>]*value="([^"]+)"/);
        const tempStringMatch = html.match(/name="aiowps-captcha-temp-string"[^>]*value="([^"]+)"/);
        
        if (!stringInfoMatch || !tempStringMatch) {
            throw new Error('Could not find captcha verification strings');
        }
        
        // Triple check the solution
        const answer = tripleCheckSolution(equation);
        
        // Verify against the temp string if available
        if (tempStringMatch[1]) {
            const expectedAnswer = parseInt(tempStringMatch[1], 10);
            if (!isNaN(expectedAnswer) && expectedAnswer !== answer) {
                console.error('Warning: Calculated answer differs from expected answer');
                console.error(`Calculated: ${answer}, Expected: ${expectedAnswer}`);
            }
        }
        
        return {
            answer,
            stringInfo: stringInfoMatch[1],
            tempString: tempStringMatch[1],
            equation: equation
        };
    } catch (error) {
        console.error('Error in extractAndSolveCaptcha:', error);
        throw error;
    }
}

module.exports = {
    generateCaptcha,
    verifyCaptcha,
    generateCaptchaHTML,
    solveCaptcha,
    extractAndSolveCaptcha,
    tripleCheckSolution,
    wordToNumber,
    numberToWord
}; 